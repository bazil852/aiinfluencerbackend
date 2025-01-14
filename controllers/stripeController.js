import stripe from "../utils/stripe.js";
import supabase from "../supabaseClient.js";
import dotenv from "dotenv";
dotenv.config();

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const oldplans = [
  {
    name: "Basic",
    price: 30,
    features: [
      "All Free plan features",
      "Increased API calls",
      "Email support",
    ],
    duration: "/month",
    link: "https://buy.stripe.com/test_14kcPLfK62pr9pu3cc",
    priceId: "price_1QShokFK63VyJS7h2XWMMXkM",
  },
  {
    name: "Pro",
    price: 60,
    features: [
      "All Basic plan features",
      "Unlimited API calls",
      "Priority support",
      "Access to premium features",
    ],
    duration: "/month",
    link: "https://buy.stripe.com/test_dR6aHD55s2pr59efYZ",
    priceId: "price_1QbgQjFK63VyJS7h8TWavrrG",
  },
];

// app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
export const handleStripeWebhook = async (request, response) => {
  const sig = request.headers["stripe-signature"];

  let data;
  let eventType;
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    console.log(err);
    response.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  data = event.data;
  eventType = event.type;

  // Fetch plans from Supabase
  const { data: plans, error: plansError } = await supabase.from("plans").select("*");
  if (plansError) {
    console.error("Error fetching plans from Supabase:", plansError);
    return response.status(500).send("Error fetching plans.");
  }

  // Handle the event
  switch (eventType) {
    // case "payment_intent.succeeded":
    //   const paymentIntentSucceeded = event.data.object;
    //   break;
    case "checkout.session.completed": {
      console.log("checkout.session.completed case");
      const session = await stripe.checkout.sessions.retrieve(data.object.id, {
        expand: ["line_items"],
      });

      const customerId = session?.customer;
      const subscriptionId = session?.subscription.id;
      const customer = await stripe.customers.retrieve(customerId);
      console.log("subscriptionId", subscriptionId);

      if (!customer || !customer.email) {
        console.error("Customer data is missing or email is not available.");
        break;
      }

      const lineItems = session?.line_items?.data;
      if (!lineItems || lineItems.length === 0) {
        console.error("No line items found in the session.");
        break;
      }

      // Assuming single plan per session
      const priceId = lineItems[0]?.price?.id;

      plans.map((plan)=>{
        console.log("Price Id Plan",plan)
      })

      const plan = plans.find((plan) => plan.price_Id === priceId); // Match with Supabase plan
      console.log("PLAN", plan, priceId);

      // const plan = plans.find((plan) => plan.priceId === priceId);
      // console.log("PLAN", plan, priceId);

      if (!plan) {
        console.error("No matching plan found for priceId:", priceId);
        break;
      }

      // Update user's tier and priceId in Supabase
      if (customer.email) {
        const { error } = await supabase
          .from("users")
          .update({
            current_plan: plan.id, // Store plan ID
            price_id: priceId, // Update with Stripe price ID
            subscription_id: subscriptionId, // Update with subscription ID
          })
          .eq("email", customer.email);

        if (error) {
          console.error("Error updating user in Supabase:", error);
          throw new Error("Failed to update user tier and priceId");
        }

        console.log(`User ${customer.email} updated to tier: ${plan.plan_name}`);
      } else {
        console.error("No email found for customer.");
      }

      //Provide access to user meaning update user also send email to user for updated subscription

      break;
    }

    case "customer.subscription.deleted": {
      const subscription = await stripe.subscriptions.retrieve(data.object.id);
      const customer = await stripe.customers.retrieve(subscription.customer);
      console.log("SUB Detail", customer);

      if (!customer || !customer.email) {
        console.error("Customer data is missing or email is not available.");
        break;
      }

      if (customer.email) {
        // Reset user's tier to 'free' and remove price_id
        const { error } = await supabase
          .from("users")
          .update({
            current_plan: null, // Clear current_plan
            price_id: null, // Clear priceId
            subscription_id: null, // Clear subscription ID
          })
          .eq("email", customer.email);

        if (error) {
          console.error("Error resetting user tier in Supabase:", error);
          throw new Error("Failed to reset user tier and priceId");
        }

        console.log(`User ${customer.email} reset to tier: free`);
      } else {
        console.error("No email found for customer.");
      }
      //Revoke user access to subscription and also send email about it

      break;
    }

    case "customer.subscription.updated": {
      const subscription = data.object;
      const customer = await stripe.customers.retrieve(subscription.customer);
      const priceId = subscription.items.data[0].price.id;

      const plan = plans.find((plan) => plan.price_Id === priceId); 
      // const plan = plans.find((plan) => plan.priceId === priceId);

      if (!plan) {
        console.error("No matching plan found for priceId:", priceId);
        break;
      }

      console.log("Subscription updated for customer:", customer.email, subscription);

      // Update user's tier and priceId in Supabase
      if (customer.email) {plan
        const { error } = await supabase
          .from("users")
          .update({
            current_plan: plan.id, // Store plan ID
            price_id: priceId, // Update priceId
            subscription_id: subscription.id, // Update subscription_id
          })
          .eq("email", customer.email);

        if (error) {
          console.error("Error updating user subscription in Supabase:", error);
          throw new Error("Failed to update user subscription");
        }

        console.log(`User ${customer.email} updated to tier: ${plan.plan_name}`);
      } else {
        console.error("No email found for customer.");
      }

      break;
    }

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a 200 response to acknowledge receipt of the event
  response.send();
};

export const handleCancelSubscripton = async (request, response) => {
  const { email, subId } = request.body;
  if (!email) {
    return response.status(400).json({ error: "Email is required" });
  }

  if(!subId){
    return response.status(400).json({ error: "Subscription Id is required" });
  }

  try {
    // Fetch customer by email
    const customers = await stripe.customers.list({ email });
    const customer = customers.data[0];

    if (!customer) {
      return response.status(404).json({ error: "Customer not found" });
    }
    console.log(customer, subId);

    // Cancel the subscription
    const canceledSubscription = await stripe.subscriptions.cancel(
        subId
    );

    response.status(200).json({ success: true, canceledSubscription });
  } catch (error) {
    console.error("Error canceling subscription:", error.message);
    response.status(500).json({ error: "Failed to cancel subscription" });
  }
};

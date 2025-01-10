import express from "express";
import { handleCancelSubscripton, handleStripeWebhook } from "../controllers/stripeController.js";

const router = express.Router();

// Stripe webhook endpoint
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

router.post(
    "/cancel-subscription",
    handleCancelSubscripton
  );

router.get("/", (req, res) => {
  res.status(200).json({
    message:
      "Stripe webhook endpoint is active. Use POST to send webhook events.",
    info: "This endpoint is used for handling Stripe webhook events. Please send POST requests with valid Stripe payloads.",
  });
});

// You can add other Stripe-related routes here, e.g., creating checkout sessions

export default router;

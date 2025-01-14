import express from "express";
import axios from "axios";
import stripeRoutes from "./routes/stripeRoutes.js";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// Define __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());

app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    next(); // Skip body parsing for /webhook
  } else {
    express.json()(req, res, next); // Apply JSON parser to other routes
  }
});

app.use("/api/stripe", stripeRoutes);

app.get("/", (req, res) => {
  res.send("Welcome to the API!");
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const HEYGEN_API_URL = "https://api.heygen.com";

// Fetch all active webhooks from the database
async function fetchActiveWebhooks() {
  const { data, error } = await supabase
    .from("webhooks")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Error fetching active webhooks:", error);
    return [];
  }

  return data;
}

// Fetch API key for a given user ID
async function fetchApiKey(userId) {
  const { data, error } = await supabase
    .from("api_keys")
    .select("heygen_key")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    console.error("Error fetching HeyGen API key:", error);
    throw new Error("HeyGen API key not found");
  }

  return data.heygen_key;
}

// HeyGen Video Creation
async function createVideo({ templateId, script, title, heygenApiKey }) {
  try {
    console.log("Heygen id: ", templateId);
    const response = await axios.post(
      `${HEYGEN_API_URL}/v2/template/${templateId}/generate`,
      {
        test: false,
        caption: false,
        title,
        variables: {
          Script: {
            name: "Script",
            type: "text",
            properties: {
              content: script,
            },
          },
        },
      },
      {
        headers: {
          "X-Api-Key": heygenApiKey,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.data?.data?.video_id) {
      throw new Error("No video ID received from HeyGen API");
    }

    return response.data.data.video_id;
  } catch (error) {
    console.error("HeyGen API Error:", error.response?.data || error.message);
    throw new Error("Failed to create video with HeyGen");
  }
}

// Insert new content in Supabase
async function createContentInSupabase(
  influencerId,
  title,
  script,
  videoId,
  videoUrl,
  status = "generating",
  error = null
) {
  const { data, error: insertError } = await supabase
    .from("contents") // Assuming your table is 'contents'
    .insert([
      {
        influencer_id: influencerId,
        title,
        script,
        status,
        video_url: videoUrl,
        video_id: videoId,
        error,
      },
    ]);

  if (insertError) {
    console.error("Error inserting content in Supabase:", insertError);
    throw new Error("Failed to insert content in Supabase");
  }

  return data;
}

// Dynamic Webhook Handlers
async function setupDynamicEndpoints() {
  console.log("Setting up dynamic webhook endpoints...");
  const webhooks = await fetchActiveWebhooks();

  for (const webhook of webhooks) {
    if (webhook.webhook_type !== "webhook") {
      console.log(
        `Skipping webhook with id: ${webhook.id} because type is ${webhook.webhook_type}`
      );
      continue;
    }
    const { id, name, url, influencer_id, event, user_id } = webhook;

    const endpointPath = new URL(url).pathname; // Extract endpoint path from the webhook's URL

    app.post(endpointPath, async (req, res) => {
      const { title, script } = req.body;

      if (!title || !script) {
        return res.status(400).json({ error: "Title and script are required" });
      }

      try {
        // Fetch influencer details
        const { data: influencer, error: influencerError } = await supabase
          .from("influencers")
          .select("template_id")
          .eq("id", influencer_id)
          .single();
        console.log("id: ", influencer);
        // console.log("Error: ",influencerError);

        if (influencerError || !influencer) {
          console.error(`Influencer data not found for webhook ${id}`);
          return res.status(404).json({ error: "Influencer not found" });
        }

        // Fetch HeyGen API key for the user
        const heygenApiKey = await fetchApiKey(user_id);

        // Call HeyGen API to generate a video
        const videoId = await createVideo({
          templateId: influencer.template_id,
          script,
          title,
          heygenApiKey,
        });

        console.log(
          `Video generated successfully for webhook "${name}" with ID: ${videoId}`
        );

        const videoUrl = `${HEYGEN_API_URL}/videos/${videoId}`;

        // Insert new content record in Supabase
        const newContent = await createContentInSupabase(
          webhook.influencer_id,
          title,
          script,
          videoId,
          videoUrl,
          "generating"
        );

        console.log(`New content record created:`, newContent);

        return res.status(200).json({ success: true, videoId });
      } catch (error) {
        console.error(`Error processing webhook ${id}:`, error.message);

        // Insert a failed content record
        await createContentInSupabase(
          webhook.influencer_id,
          title,
          script,
          null,
          null,
          "failed",
          error.message
        );

        return res.status(500).json({ error: error.message });
      }
    });

    console.log(`Webhook endpoint created for: ${url}`);
  }
}

// Run dynamic setup at startup
setupDynamicEndpoints();

// New Endpoint for HeyGen Webhooks
app.post("/api/heygen-webhook", async (req, res) => {
  const { event_type, event_data } = req.body;

  if (!event_type || !event_data?.video_id) {
    return res.status(400).json({ error: "Invalid payload structure" });
  }

  const { video_id, url: videoUrl } = event_data;

  try {
    // Match the video ID in the contents table
    const { data: content, error: contentError } = await supabase
      .from("contents")
      .select("id, influencer_id, title, script")
      .eq("video_id", video_id)
      .single();

    if (contentError || !content) {
      console.error("Content not found:", contentError || "No content found");
      return res.status(404).json({ error: "Content not found" });
    }

    const { influencer_id, title, script } = content;

    // Fetch the influencer's name
    const { data: influencer, error: influencerError } = await supabase
      .from("influencers")
      .select("name")
      .eq("id", influencer_id)
      .single();

    if (influencerError || !influencer) {
      console.error(
        "Influencer not found:",
        influencerError || "No influencer found"
      );
      return res.status(404).json({ error: "Influencer not found" });
    }

    const influencerName = influencer.name;

    // Fetch all automation webhooks for the influencer
    const { data: automationWebhooks, error: webhooksError } = await supabase
      .from("webhooks")
      .select("url")
      .eq("influencer_id", influencer_id)
      .eq("webhook_type", "automation");

    if (webhooksError || !automationWebhooks.length) {
      console.error(
        "No automation webhooks found:",
        webhooksError || "No webhooks found"
      );
      return res.status(404).json({ error: "No automation webhooks found" });
    }

    // Prepare data to send to the automation webhooks
    const payload = {
      event: "video.completed",
      content: {
        title,
        script,
        influencerName,
        video_url: videoUrl,
        status: "completed",
      },
    };

    console.log(`Payload prepared for automation webhooks:`, payload);

    // Send data to each automation webhook URL
    for (const webhook of automationWebhooks) {
      try {
        await axios.post(webhook.url, payload, {
          headers: { "Content-Type": "application/json" },
        });
        console.log(`Automation webhook called successfully: ${webhook.url}`);
      } catch (error) {
        console.error(
          `Failed to call automation webhook: ${webhook.url}`,
          error.message
        );
      }
    }

    // Download video from videoUrl
    const videoPath = path.join(__dirname, `temp_${uuidv4()}.mp4`);
    const writer = fs.createWriteStream(videoPath);

    const videoResponse = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
    });

    videoResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log(`Video downloaded successfully to ${videoPath}`);

    // Upload video to Supabase storage
    const supabaseStorageName = "influencers_content_videos";
    const fileName = `video_${uuidv4()}.mp4`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(supabaseStorageName)
      .upload(fileName, fs.createReadStream(videoPath), {
        contentType: "video/mp4",
      });

    if (uploadError) {
      console.error("Error uploading video to Supabase:", uploadError);
      return res
        .status(500)
        .json({ error: "Failed to upload video to Supabase storage" });
    }

    console.log("Video uploaded successfully to Supabase storage");

    // Get public URL of the video
    const { data: publicUrlData } = supabase.storage
      .from(supabaseStorageName)
      .getPublicUrl(fileName);

    if (!publicUrlData?.publicUrl) {
      console.error("Error retrieving public URL for uploaded video");
      return res
        .status(500)
        .json({ error: "Failed to retrieve public URL for video" });
    }

    const supabaseVideoUrl = publicUrlData.publicUrl;

    console.log("Supabase video public URL:", supabaseVideoUrl);

    // Clean up temporary video file
    fs.unlink(videoPath, (err) => {
      if (err) {
        console.error("Error deleting temporary video file:", err);
      } else {
        console.log("Temporary video file deleted successfully");
      }
    });

    // Update content status in Supabase
    await supabase
      .from("contents")
      .update({ status: "completed", video_url: videoUrl })
      .eq("id", content.id);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error processing HeyGen webhook:", error.message);
    return res.status(500).json({ error: error.message });
  }
});


app.post("/api/upload-video", async (req, res) => {
  const { videoUrl, title, video_id } = req.body;

  if (!videoUrl || !title || !video_id) {
    return res
      .status(400)
      .json({ error: "videoUrl, title, and video_id are required" });
  }

  const bucket = "influencers_content_videos"; // Replace with your actual bucket name
  const sanitizedTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase(); // Sanitize title
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "_"); // Add timestamp to file name
  const objectKey = `${sanitizedTitle}_${video_id}_${timestamp}.mp4`; // Construct object key


  try {
    // Download video data as a buffer
    const response = await fetch(videoUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch video. HTTP status: ${response.status}`);
    }

    const videoBuffer = await response.arrayBuffer();

    // Upload the video directly to Supabase Storage
    const { error } = await supabase.storage.from(bucket).upload(objectKey, videoBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

    if (error) {
      throw new Error(`Error uploading video: ${error.message}`);
    }

    console.log(`Video uploaded to Supabase Storage bucket: ${bucket}`, {
      objectKey,
    });

    // Get the public URL for the uploaded video
    const { data: publicUrl  } = supabase.storage.from(bucket).getPublicUrl(objectKey);

    if (!publicUrl) {
      throw new Error("Failed to retrieve public URL for the uploaded video");
    }

    console.log("Public URL:", publicUrl);

    // Send the response back with success and video details
    return res.status(200).json({
      success: true,
      bucket,
      objectKey,
      video_url: publicUrl,
    });
  } catch (error) {
    console.error("Error during Supabase video upload:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Periodic Check for New Webhooks
setInterval(async () => {
  console.log("Refreshing webhook endpoints...");
  setupDynamicEndpoints();
}, 60000); // Refresh every 60 seconds

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

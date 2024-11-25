const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const HEYGEN_API_URL = 'https://api.heygen.com';

// Fetch all active webhooks from the database
async function fetchActiveWebhooks() {
  const { data, error } = await supabase
    .from('webhooks')
    .select('*')
    .eq('active', true);

  if (error) {
    console.error('Error fetching active webhooks:', error);
    return [];
  }

  return data;
}

// Fetch API key for a given user ID
async function fetchApiKey(userId) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('heygen_key')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    console.error('Error fetching HeyGen API key:', error);
    throw new Error('HeyGen API key not found');
  }

  return data.heygen_key;
}

// HeyGen Video Creation
async function createVideo({ templateId, script, title, heygenApiKey }) {
  try {
    console.log ("Heygen id: ",templateId);
    const response = await axios.post(
      `${HEYGEN_API_URL}/v2/template/${templateId}/generate`,
      {
        test: false,
        caption: false,
        title,
        variables: {
          Script: {
            name: 'Script',
            type: 'text',
            properties: {
              content: script,
            },
          },
        },
      },
      {
        headers: {
          'X-Api-Key': heygenApiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data?.data?.video_id) {
      throw new Error('No video ID received from HeyGen API');
    }

    return response.data.data.video_id;
  } catch (error) {
    console.error('HeyGen API Error:', error.response?.data || error.message);
    throw new Error('Failed to create video with HeyGen');
  }
}

// Insert new content in Supabase
async function createContentInSupabase(influencerId, title, script, videoId, videoUrl, status = 'generating', error = null) {
    const { data, error: insertError } = await supabase
      .from('contents') // Assuming your table is 'contents'
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
      console.error('Error inserting content in Supabase:', insertError);
      throw new Error('Failed to insert content in Supabase');
    }
  
    return data;
  }
  

// Dynamic Webhook Handlers
async function setupDynamicEndpoints() {
  console.log('Setting up dynamic webhook endpoints...');
  const webhooks = await fetchActiveWebhooks();

  for (const webhook of webhooks) {
    if (webhook.webhook_type !== "webhook") {
      console.log(`Skipping webhook with id: ${webhook.id} because type is ${webhook.webhook_type}`);
      continue;
    }
    const { id, name, url, influencer_id, event, user_id } = webhook;

    const endpointPath = new URL(url).pathname; // Extract endpoint path from the webhook's URL

    app.post(endpointPath, async (req, res) => {
      const { title, script } = req.body;

      if (!title || !script) {
        return res.status(400).json({ error: 'Title and script are required' });
      }

      try {
        // Fetch influencer details
        const { data: influencer, error: influencerError } = await supabase
          .from('influencers')
          .select('template_id')
          .eq('id', influencer_id)
          .single();
        console.log("id: ",influencer);
        // console.log("Error: ",influencerError);
        
        if (influencerError || !influencer) {
          console.error(`Influencer data not found for webhook ${id}`);
          return res.status(404).json({ error: 'Influencer not found' });
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

        console.log(`Video generated successfully for webhook "${name}" with ID: ${videoId}`);

        const videoUrl = `${HEYGEN_API_URL}/videos/${videoId}`;
    
        // Insert new content record in Supabase
        const newContent = await createContentInSupabase(
          webhook.influencer_id,
          title,
          script,
          videoId,
          videoUrl,
          'generating'
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
        'failed',
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
app.post('/api/heygen-webhook', async (req, res) => {
  const { event_type, event_data } = req.body;

  if (!event_type || !event_data?.video_id) {
    return res.status(400).json({ error: 'Invalid payload structure' });
  }

  const { video_id, url: videoUrl } = event_data;

  try {
    // Match the video ID in the contents table
    const { data: content, error: contentError } = await supabase
      .from('contents')
      .select('id, influencer_id, title, script')
      .eq('video_id', video_id)
      .single();

    if (contentError || !content) {
      console.error('Content not found:', contentError || 'No content found');
      return res.status(404).json({ error: 'Content not found' });
    }

    const { influencer_id, title, script } = content;

    // Fetch the influencer's name
    const { data: influencer, error: influencerError } = await supabase
      .from('influencers')
      .select('name')
      .eq('id', influencer_id)
      .single();

    if (influencerError || !influencer) {
      console.error('Influencer not found:', influencerError || 'No influencer found');
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const influencerName = influencer.name;

    // Fetch all automation webhooks for the influencer
    const { data: automationWebhooks, error: webhooksError } = await supabase
      .from('webhooks')
      .select('url')
      .eq('influencer_id', influencer_id)
      .eq('webhook_type', 'automation');

    if (webhooksError || !automationWebhooks.length) {
      console.error('No automation webhooks found:', webhooksError || 'No webhooks found');
      return res.status(404).json({ error: 'No automation webhooks found' });
    }

    // Prepare data to send to the automation webhooks
    const payload = {
      event: 'video.completed',
      content: {
        title,
        script,
        influencerName,
        video_url: videoUrl,
        status: 'completed',
      },
    };

    console.log(`Payload prepared for automation webhooks:`, payload);

    // Send data to each automation webhook URL
    for (const webhook of automationWebhooks) {
      try {
        await axios.post(webhook.url, payload, {
          headers: { 'Content-Type': 'application/json' },
        });
        console.log(`Automation webhook called successfully: ${webhook.url}`);
      } catch (error) {
        console.error(`Failed to call automation webhook: ${webhook.url}`, error.message);
      }
    }

    // Update content status in Supabase
    await supabase
      .from('contents')
      .update({ status: 'completed', video_url: videoUrl })
      .eq('id', content.id);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing HeyGen webhook:', error.message);
    return res.status(500).json({ error: error.message });
  }
});





// Periodic Check for New Webhooks
setInterval(async () => {
  console.log('Refreshing webhook endpoints...');
  setupDynamicEndpoints();
}, 60000); // Refresh every 60 seconds

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

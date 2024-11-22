const supabase = require('../supabaseClient');

// Create Webhook
exports.createWebhook = async (req, res) => {
  const { userId, name, url, event, influencerIds } = req.body;

  if (!userId || !name || !url || !event || !influencerIds) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const promises = influencerIds.map(async (influencerId) => {
      const { data, error } = await supabase
        .from('webhooks')
        .insert({
          user_id: userId,
          name,
          url,
          event,
          influencer_id: influencerId,
          active: true,
          created_at: new Date().toISOString()
        });

      if (error) throw error;
      return data[0];
    });

    const newWebhooks = await Promise.all(promises);
    res.status(201).json(newWebhooks);
  } catch (error) {
    console.error('Error creating webhook:', error);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
};

// Get All Webhooks
exports.getWebhooks = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId query parameter' });
  }

  try {
    const { data, error } = await supabase
      .from('webhooks')
      .select('*, influencers(name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching webhooks:', error);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
};

// Update Webhook
exports.updateWebhook = async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!id || !updates) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const { data, error } = await supabase
      .from('webhooks')
      .update(updates)
      .eq('id', id);

    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error updating webhook:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
};

// Delete Webhook
exports.deleteWebhook = async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing webhook ID' });
  }

  try {
    const { error } = await supabase
      .from('webhooks')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
};

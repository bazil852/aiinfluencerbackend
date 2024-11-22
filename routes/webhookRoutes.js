const express = require('express');
const { 
  createWebhook,
  getWebhooks,
  updateWebhook,
  deleteWebhook 
} = require('../controllers/webhookController');

const router = express.Router();

// CRUD Operations for Webhooks
router.post('/', createWebhook); // Create a new webhook
router.get('/', getWebhooks);    // Get all webhooks
router.put('/:id', updateWebhook); // Update a webhook
router.delete('/:id', deleteWebhook); // Delete a webhook

module.exports = router;

const express = require('express');
const wa = require('../services/whatsappService');
const instantLeads = require('../services/instantLeadService');

/**
 * Webhook de leadgen da Página do Facebook (formulário instantâneo).
 * Mesma verificação do WhatsApp: WHATSAPP_VERIFY_TOKEN e o segredo do app
 * (WHATSAPP_APP_SECRET ou META_APP_SECRET). A Página do evento precisa ser
 * a cadastrada no cliente (Integrações → ID da Página).
 */
const router = express.Router();

router.get('/', (req, res) => {
  const challenge = wa.verifyChallenge(req.query || {});
  if (challenge === null) return res.sendStatus(403);
  res.status(200).type('text/plain').send(challenge);
});

router.post('/', async (req, res) => {
  if (!wa.signatureOk(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  try {
    const r = await instantLeads.handleWebhook(req.body);
    if (r.created) console.log(`Instant Form: ${r.created} lead(s).`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook de Instant Form falhou:', err);
    res.sendStatus(500);
  }
});

module.exports = router;

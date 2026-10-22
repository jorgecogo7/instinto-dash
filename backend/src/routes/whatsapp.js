const express = require('express');
const wa = require('../services/whatsappService');

/**
 * Webhook da WhatsApp Cloud API (configurado no app da Meta):
 *   URL de retorno:  https://<api>/api/whatsapp/webhook
 *   Token de verificação: o mesmo valor de WHATSAPP_VERIFY_TOKEN
 *   Campo assinado: messages
 * Sem login (quem chama é a Meta). O POST só é aceito com a assinatura
 * X-Hub-Signature-256 válida (WHATSAPP_APP_SECRET).
 */
const router = express.Router();

router.get('/webhook', (req, res) => {
  const challenge = wa.verifyChallenge(req.query || {});
  if (challenge === null) return res.sendStatus(403);
  res.status(200).type('text/plain').send(challenge);
});

router.post('/webhook', async (req, res) => {
  if (!wa.signatureOk(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  try {
    const r = await wa.handleWebhook(req.body);
    if (r.messages || r.statuses) console.log(`WhatsApp: ${r.messages} mensagem(ns), ${r.statuses} status.`);
    res.sendStatus(200);
  } catch (err) {
    console.error('WhatsApp webhook falhou:', err);
    res.sendStatus(500); // a Meta tenta de novo
  }
});

module.exports = router;

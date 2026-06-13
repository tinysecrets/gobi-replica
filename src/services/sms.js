import config from '../config.js';

/**
 * Twilio SMS Gateway Service — v2
 *
 * Sends and receives SMS via Twilio API.
 * Uses native fetch (no heavy Twilio SDK) to stay lightweight.
 *
 * Receiving:
 *   Your agent exposes a POST webhook endpoint (default /api/sms/webhook).
 *   Configure that URL in your Twilio console for the number.
 *   The webhook handler should call smsService.handleIncoming(body).
 */
class SMSService {
  constructor() {
    this.enabled = config.sms.enabled;
    this.accountSid = config.sms.accountSid;
    this.authToken = config.sms.authToken;
    this.fromNumber = config.sms.fromNumber;
  }

  /** Build Basic Auth header from Account SID + Auth Token */
  _auth() {
    const creds = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    return `Basic ${creds}`;
  }

  /** Send an outbound SMS */
  async send(to, body, options = {}) {
    if (!this.enabled || !this.accountSid || !this.authToken) {
      throw new Error('SMS not enabled or credentials missing. Set SMS_ENABLED=true and Twilio env vars.');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({
      From: this.fromNumber,
      To: to,
      Body: body,
      ...options,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this._auth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Twilio send failed: ${res.status} ${err.slice(0, 200)}`);
    }

    return res.json();
  }

  /** Handle an incoming SMS webhook payload from Twilio */
  handleIncoming(body) {
    // Standard Twilio webhook body fields:
    //   From, To, Body, MessageSid, AccountSid, NumMedia, NumSegments, ...
    const message = {
      type: 'sms_inbound',
      from: body.From || body.from,
      to: body.To || body.to,
      body: body.Body || body.body,
      messageSid: body.MessageSid || body.messageSid,
      numMedia: parseInt(body.NumMedia || body.numMedia || '0', 10),
      numSegments: parseInt(body.NumSegments || body.numSegments || '1', 10),
      raw: body,
      receivedAt: new Date().toISOString(),
    };
    return message;
  }

  /** Validate that a Twilio webhook request is authentic (optional but recommended).
   *  In a real app you'd verify the X-Twilio-Signature header against your URL.
   *  For brevity we accept all requests in this minimal version —
   *  users can add HMAC validation later.
   */
  isValidWebhook() {
    // TODO: implement X-Twilio-Signature HMAC validation if desired
    return true;
  }
}

export default SMSService;
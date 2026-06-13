import nodemailer from 'nodemailer';
import config from '../config.js';

class EmailService {
  constructor() {
    this.transporter = null;
  }

  init() {
    if (config.email.host && config.email.user) {
      this.transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: { user: config.email.user, pass: config.email.pass },
      });
    }
    return this;
  }

  async send(to, subject, html, options = {}) {
    if (!this.transporter) throw new Error('SMTP not configured.');
    const info = await this.transporter.sendMail({
      from: options.from || config.email.from,
      to, subject, html,
      attachments: options.attachments || [],
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  }
}

export default EmailService;

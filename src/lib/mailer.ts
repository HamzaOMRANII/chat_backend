import nodemailer from "nodemailer";
import type { Config } from "../config/env.js";

export type Mailer = {
  sendCode(input: { to: string; code: string; purpose: "login" | "admin-login" | "email-change"; minutes: number }): Promise<void>;
};

const SUBJECTS = {
  login: "Your H_CHAT sign-in code",
  "admin-login": "Your H_CHAT backoffice sign-in code",
  "email-change": "Confirm your new H_CHAT email",
} as const;

export function createMailer(config: Config): Mailer {
  const transporter = nodemailer.createTransport({
    host: config.EMAIL_HOST,
    port: config.EMAIL_PORT,
    secure: config.EMAIL_PORT === 465,
    auth: { user: config.EMAIL_FROM, pass: config.EMAIL_PASSWORD },
    tls: { minVersion: "TLSv1.2" },
  });

  return {
    async sendCode({ to, code, purpose, minutes }) {
      const subject = SUBJECTS[purpose];
      await transporter.sendMail({
        from: `H_CHAT <${config.EMAIL_FROM}>`,
        to,
        subject,
        text: `${subject}: ${code}\n\nIt expires in ${minutes} minutes and works once. If you didn't ask for it, change your H_CHAT password.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111">
<p style="font-family:monospace;font-size:18px;font-weight:bold">H<span style="color:#8C2A3F">_</span>CHAT</p>
<p>${subject}:</p>
<p style="font-family:monospace;font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p>
<p>It expires in ${minutes} minutes and works once. If you didn't ask for it, change your H_CHAT password.</p></div>`,
      });
    },
  };
}

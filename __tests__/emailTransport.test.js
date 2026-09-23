// The mail transport adapter (2026-09-23): new users' verification codes were
// landing in spam because everything left from a free @gmail.com account. With
// MAIL_FROM on the domain + a SendGrid key the adapter sends from the domain;
// without them it is the Gmail SMTP path exactly as before.
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn(async () => [{ headers: { 'x-message-id': 'sg-1' } }]) }));
const sgMail = require('@sendgrid/mail');
const { buildTransport } = require('../services/emailService');

describe('buildTransport', () => {
    test('domain sender + Resend key -> Resend HTTPS, from on the domain, reply-to from opts or support', async () => {
        const calls = [];
        const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 're-1' }) }; };
        const t = buildTransport({ MAIL_FROM: 'noreply@jinni.travel', RESEND_API_KEY: 're_k', SENDGRID_API_KEY: 'k', SUPPORT_EMAIL: 'hello@jinni.travel' }, { fetch: fakeFetch });
        expect(t.kind).toBe('resend');   // Resend outranks SendGrid when both keys exist
        const r = await t.sendMail({ from: '"Jinni AI" <old@gmail.com>', to: 'u@example.com', subject: 'Code', html: '<b>1</b>', text: '1' });
        expect(r.messageId).toBe('re-1');
        const body = JSON.parse(calls[0].init.body);
        expect(calls[0].url).toBe('https://api.resend.com/emails');
        expect(calls[0].init.headers.Authorization).toBe('Bearer re_k');
        expect(body.from).toBe('Jinni AI <noreply@jinni.travel>');
        expect(body.to).toEqual(['u@example.com']);
        expect(body.reply_to).toBe('hello@jinni.travel');
        await t.sendMail({ from: '"Jinni Support" <x>', to: 's@jinni.travel', subject: 'c', text: 'm', replyTo: 'visitor@example.com' });
        expect(JSON.parse(calls[1].init.body).reply_to).toBe('visitor@example.com');   // contact form: reply goes to the visitor
    });
    test('Resend failure surfaces as an error, never a silent success', async () => {
        const t = buildTransport({ MAIL_FROM: 'noreply@jinni.travel', RESEND_API_KEY: 're_k' }, { fetch: async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) }) });
        await expect(t.sendMail({ from: 'Jinni', to: 'u@example.com', subject: 's', text: 't' })).rejects.toThrow(/403.*domain not verified/);
    });
    test('domain sender + key -> SendGrid, from rewritten to the domain, display name and reply-to kept', async () => {
        const t = buildTransport({ MAIL_FROM: 'noreply@jinni.travel', SENDGRID_API_KEY: 'k', SUPPORT_EMAIL: 'hello@jinni.travel', EMAIL_USER: 'old@gmail.com' });
        expect(t.kind).toBe('sendgrid');
        const r = await t.sendMail({ from: '"Jinni AI" <old@gmail.com>', to: 'u@example.com', subject: 'Code', html: '<b>1234</b>', text: '1234' });
        const msg = sgMail.send.mock.calls[0][0];
        expect(msg.from).toEqual({ email: 'noreply@jinni.travel', name: 'Jinni AI' });
        expect(msg.replyTo).toBe('hello@jinni.travel');
        expect(msg.to).toBe('u@example.com');
        expect(msg.trackingSettings.clickTracking.enable).toBe(false);
        expect(r.messageId).toBe('sg-1');
    });
    test('no MAIL_FROM, or a gmail MAIL_FROM -> the Gmail SMTP path', () => {
        expect(buildTransport({ SENDGRID_API_KEY: 'k', EMAIL_USER: 'x@gmail.com', EMAIL_APP_PASSWORD: 'p' }).kind).toBe('gmail');
        expect(buildTransport({ MAIL_FROM: 'jinni@gmail.com', SENDGRID_API_KEY: 'k', EMAIL_USER: 'x@gmail.com', EMAIL_APP_PASSWORD: 'p' }).kind).toBe('gmail');
        expect(buildTransport({ MAIL_FROM: 'noreply@jinni.travel', EMAIL_USER: 'x@gmail.com', EMAIL_APP_PASSWORD: 'p' }).kind).toBe('gmail');   // no key
        expect(buildTransport({ MAIL_FROM: 'jinni@gmail.com', RESEND_API_KEY: 're_k', EMAIL_USER: 'x@gmail.com', EMAIL_APP_PASSWORD: 'p' }).kind).toBe('gmail');   // a gmail MAIL_FROM never uses a provider
    });
});

/**
 * @typedef {'en' | 'vi'} Language
 * @typedef {{
 *   name?: string, displayName?: string, email?: string, applicantEmail?: string, reason?: string,
 *   temporaryPassword?: string, expiresAt?: string, origin?: string,
 * }} EmailData
 * @typedef {{
 *   subject: string, greeting?: string, paragraphs: string[], details?: Array<[string, string]>,
 *   link?: { label: string, url: string }, after?: string[],
 * }} EmailContent
 * @typedef {{ subject: string, text: string, html: string }} RenderedEmail
 */

const COLORS = { bg: '#F3EFE6', card: '#FBF7EE', ink: '#1F2823', muted: '#6B7771', line: '#DCD4C3', accent: '#B8643F' };

const FOOTER = {
  en: 'This email was sent automatically by Connect (SAPAWOO). Please do not reply.',
  vi: 'Email này được gửi tự động từ Connect (SAPAWOO). Vui lòng không trả lời.',
};

/** Vietnam time, e.g. "9 Oct 2026, 16:32". @param {string | undefined} iso @param {Language} language */
export function formatVietnamTime(iso, language) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** @param {EmailData} d @param {Language} language */
function credentials(d, language) {
  const expires = formatVietnamTime(d.expiresAt, language);
  const login = `${d.origin}/login`;
  return language === 'vi'
    ? {
        details: /** @type {Array<[string, string]>} */ ([
          ['Email đăng nhập', d.email ?? ''],
          ['Mật khẩu tạm', d.temporaryPassword ?? ''],
          ['Hết hạn', `${expires} (giờ Việt Nam)`],
        ]),
        link: { label: 'Đăng nhập MyConnect', url: login },
        after: [`Hãy đổi mật khẩu tạm ở lần đăng nhập đầu tiên. Mật khẩu tạm có hiệu lực đến ${expires} (giờ Việt Nam).`],
      }
    : {
        details: /** @type {Array<[string, string]>} */ ([
          ['Sign-in email', d.email ?? ''],
          ['Temporary password', d.temporaryPassword ?? ''],
          ['Expires', `${expires} (Vietnam time)`],
        ]),
        link: { label: 'Sign in to MyConnect', url: login },
        after: [`Change the temporary password at your first sign-in. It is valid until ${expires} (Vietnam time).`],
      };
}

/** @type {Record<string, Record<Language, (d: EmailData) => EmailContent>>} */
const TEMPLATES = {
  APPLICATION_RECEIVED: {
    en: (d) => ({
      subject: `We received your application for ${d.name}`,
      greeting: `Hello ${d.displayName},`,
      paragraphs: [
        `Thank you for applying to use MyConnect for ${d.name}. A platform admin will review your application.`,
        'What happens next: no account is created yet. If the application is approved, you will get another email with your sign-in details. If not, we will tell you why.',
      ],
    }),
    vi: (d) => ({
      subject: `Chúng tôi đã nhận đơn đăng ký của ${d.name}`,
      greeting: `Xin chào ${d.displayName},`,
      paragraphs: [
        `Cảm ơn bạn đã đăng ký dùng MyConnect cho ${d.name}. Quản trị nền tảng sẽ xem xét đơn của bạn.`,
        'Bước tiếp theo: chưa có tài khoản nào được tạo. Khi đơn được duyệt, bạn sẽ nhận một email khác với thông tin đăng nhập. Nếu đơn không được duyệt, chúng tôi sẽ báo lý do.',
      ],
    }),
  },
  APPLICATION_NEW_FOR_ADMINS: {
    en: (d) => ({
      subject: `New merchant application: ${d.name}`,
      paragraphs: ['A new merchant application is waiting for review.'],
      details: [
        ['Business', d.name ?? ''],
        ['Merchant admin', `${d.displayName} (${d.applicantEmail})`],
      ],
      link: { label: 'Review in Console → Merchants', url: `${d.origin}/console/merchants` },
    }),
    vi: (d) => ({
      subject: `Đơn đăng ký merchant mới: ${d.name}`,
      paragraphs: ['Có một đơn đăng ký merchant mới đang chờ duyệt.'],
      details: [
        ['Doanh nghiệp', d.name ?? ''],
        ['Admin merchant', `${d.displayName} (${d.applicantEmail})`],
      ],
      link: { label: 'Duyệt tại Console → Merchant', url: `${d.origin}/console/merchants` },
    }),
  },
  APPLICATION_APPROVED: {
    en: (d) => ({
      subject: `Your MyConnect account for ${d.name} is ready`,
      greeting: `Hello ${d.displayName},`,
      paragraphs: [`Your application for ${d.name} was approved. Sign in with these details:`],
      ...credentials(d, 'en'),
    }),
    vi: (d) => ({
      subject: `Tài khoản MyConnect của ${d.name} đã sẵn sàng`,
      greeting: `Xin chào ${d.displayName},`,
      paragraphs: [`Đơn đăng ký của ${d.name} đã được duyệt. Đăng nhập với thông tin sau:`],
      ...credentials(d, 'vi'),
    }),
  },
  APPLICATION_REJECTED: {
    en: (d) => ({
      subject: `Your application for ${d.name} was not approved`,
      greeting: `Hello ${d.displayName},`,
      paragraphs: [`Thank you for your interest in MyConnect. Your application for ${d.name} was not approved.`],
      details: [['Reason', d.reason ?? '']],
      after: [`You can send a new application at any time: ${d.origin}/register`],
    }),
    vi: (d) => ({
      subject: `Đơn đăng ký của ${d.name} chưa được duyệt`,
      greeting: `Xin chào ${d.displayName},`,
      paragraphs: [`Cảm ơn bạn đã quan tâm đến MyConnect. Đơn đăng ký của ${d.name} chưa được duyệt.`],
      details: [['Lý do', d.reason ?? '']],
      after: [`Bạn có thể gửi đơn mới bất cứ lúc nào: ${d.origin}/register`],
    }),
  },
  TEMPORARY_PASSWORD_REISSUED: {
    en: (d) => ({
      subject: 'Your new MyConnect temporary password',
      greeting: `Hello ${d.displayName},`,
      paragraphs: ['A platform admin created a new temporary password for you. The previous one no longer works.'],
      ...credentials(d, 'en'),
    }),
    vi: (d) => ({
      subject: 'Mật khẩu tạm mới cho MyConnect',
      greeting: `Xin chào ${d.displayName},`,
      paragraphs: ['Quản trị nền tảng đã tạo mật khẩu tạm mới cho bạn. Mật khẩu tạm cũ không còn dùng được.'],
      ...credentials(d, 'vi'),
    }),
  },
};

/** @param {string} value */
const esc = (value) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** @param {EmailContent} c @param {Language} language */
function toText(c, language) {
  const lines = [];
  if (c.greeting) lines.push(c.greeting, '');
  for (const p of c.paragraphs) lines.push(p, '');
  if (c.details?.length) lines.push(...c.details.map(([label, value]) => `${label}: ${value}`), '');
  if (c.link) lines.push(`${c.link.label}: ${c.link.url}`, '');
  for (const p of c.after ?? []) lines.push(p, '');
  lines.push('—', FOOTER[language]);
  return lines.join('\n');
}

/** @param {EmailContent} c @param {Language} language */
function toHtml(c, language) {
  const p = (/** @type {string} */ text) => `<p style="margin:0 0 14px;line-height:1.5">${esc(text)}</p>`;
  const details = c.details?.length
    ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;width:100%">${c.details
        .map(
          ([label, value]) =>
            `<tr><td style="padding:6px 12px 6px 0;color:${COLORS.muted};vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${esc(value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const link = c.link
    ? `<p style="margin:0 0 16px"><a href="${esc(c.link.url)}" style="display:inline-block;background:${COLORS.accent};color:#FFFFFF;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${esc(c.link.label)}</a></p><p style="margin:0 0 14px;font-size:13px;color:${COLORS.muted};word-break:break-all">${esc(c.link.url)}</p>`
    : '';
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:${COLORS.bg};color:${COLORS.ink};font-family:'DM Sans',Arial,Helvetica,sans-serif;font-size:15px">
<div style="max-width:560px;margin:0 auto;background:${COLORS.card};border:1px solid ${COLORS.line};border-radius:12px;padding:24px">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:4px;color:${COLORS.ink};margin:0 0 20px">SAPAWOO</div>
<h1 style="font-size:18px;line-height:1.3;margin:0 0 16px;color:${COLORS.ink}">${esc(c.subject)}</h1>
${c.greeting ? p(c.greeting) : ''}${c.paragraphs.map(p).join('')}${details}${link}${(c.after ?? []).map(p).join('')}
<p style="margin:20px 0 0;padding-top:14px;border-top:1px solid ${COLORS.line};font-size:12px;color:${COLORS.muted}">${esc(FOOTER[language])}</p>
</div></body></html>`;
}

/**
 * @param {string} type
 * @param {string | undefined} language
 * @param {EmailData} data
 * @returns {RenderedEmail}
 */
export function renderEmail(type, language, data) {
  const lang = language === 'vi' ? 'vi' : 'en';
  const template = TEMPLATES[type];
  if (!template) throw new Error(`Unknown email type ${type}`);
  const content = template[lang](data);
  return { subject: content.subject, text: toText(content, lang), html: toHtml(content, lang) };
}

import nodemailer, { Transporter } from "nodemailer";

let _transporter: Transporter | null = null;

function getTransporter(): Transporter {
    if (!_transporter) {
        _transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }
    return _transporter;
}

const FROM = () => process.env.EMAIL_FROM || `"CaloVie" <${process.env.SMTP_USER}>`;

// ── Shared layout wrapper ─────────────────────────────────────────────────────

function layout(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background:#f4f6f8; font-family: 'Helvetica Neue', Arial, sans-serif; }
    .wrap { max-width:560px; margin:32px auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,.08); }
    .header { background:linear-gradient(135deg,#22c55e,#16a34a); padding:32px 32px 28px; text-align:center; }
    .header img { width:48px; height:48px; margin-bottom:12px; }
    .header h1 { margin:0; color:#fff; font-size:24px; font-weight:700; letter-spacing:-0.3px; }
    .header p { margin:6px 0 0; color:rgba(255,255,255,.85); font-size:14px; }
    .body { padding:32px; }
    .body h2 { margin:0 0 12px; font-size:20px; color:#111827; }
    .body p { margin:0 0 16px; font-size:15px; color:#374151; line-height:1.65; }
    .info-box { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:20px 24px; margin:20px 0; }
    .info-box .row { display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#374151; border-bottom:1px solid #d1fae5; }
    .info-box .row:last-child { border-bottom:none; font-weight:700; }
    .info-box .label { color:#6b7280; }
    .warn-box { background:#fff7ed; border:1px solid #fed7aa; border-radius:12px; padding:16px 20px; margin:20px 0; font-size:14px; color:#92400e; }
    .expired-box { background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:16px 20px; margin:20px 0; font-size:14px; color:#991b1b; }
    .btn { display:inline-block; margin-top:8px; padding:14px 32px; background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff !important; text-decoration:none; border-radius:10px; font-size:15px; font-weight:600; }
    .footer { background:#f9fafb; border-top:1px solid #e5e7eb; padding:20px 32px; text-align:center; font-size:12px; color:#9ca3af; }
    .footer a { color:#22c55e; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>🥗 CaloVie</h1>
      <p>Dinh dưỡng thông minh — sống khoẻ mỗi ngày</p>
    </div>
    <div class="body">${body}</div>
    <div class="footer">
      Bạn nhận được email này vì có tài khoản CaloVie.<br/>
      <a href="${process.env.FRONTEND_URL || "https://CaloVie.app"}">Truy cập CaloVie</a> &nbsp;·&nbsp;
      <a href="${process.env.FRONTEND_URL || "https://CaloVie.app"}/settings">Cài đặt tài khoản</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Email: 7-day renewal reminder ─────────────────────────────────────────────

export async function sendRenewalReminder(opts: {
    to: string;
    name: string;
    tier: string;
    expiresAt: Date;
}): Promise<void> {
    const { to, name, tier, expiresAt } = opts;
    const tierLabel = tier === "pro" || tier === "family" ? "Family" : "Premium";
    const expiryStr = expiresAt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const frontendUrl = process.env.FRONTEND_URL || "https://CaloVie.app";

    const body = `
      <h2>Nhắc nhở gia hạn gói ${tierLabel} 🔔</h2>
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Gói <strong>${tierLabel}</strong> của bạn sắp hết hạn. Hãy gia hạn để không bị gián đoạn trải nghiệm nhé!</p>
      <div class="info-box">
        <div class="row"><span class="label">Gói hiện tại</span><span>${tierLabel}</span></div>
        <div class="row"><span class="label">Ngày hết hạn</span><span>${expiryStr}</span></div>
        <div class="row"><span class="label">Còn lại</span><span><strong>7 ngày</strong></span></div>
      </div>
      <div class="warn-box">
        ⚠️ Sau ngày hết hạn, tài khoản sẽ tự động chuyển về gói <strong>Free</strong>. Bạn sẽ bị giới hạn số lượt scan AI và một số tính năng nâng cao.
      </div>
      <p>Gia hạn ngay hôm nay để tiếp tục hành trình dinh dưỡng của bạn:</p>
      <a href="${frontendUrl}/subscription" class="btn">Gia hạn ngay →</a>
    `;

    await getTransporter().sendMail({
        from: FROM(),
        to,
        subject: `⏰ Gói ${tierLabel} hết hạn sau 7 ngày — Gia hạn ngay để không bị gián đoạn`,
        html: layout(`Nhắc nhở gia hạn ${tierLabel}`, body),
    });
}

// ── Email: 3-day renewal reminder ─────────────────────────────────────────────

export async function sendRenewalReminderUrgent(opts: {
    to: string;
    name: string;
    tier: string;
    expiresAt: Date;
}): Promise<void> {
    const { to, name, tier, expiresAt } = opts;
    const tierLabel = tier === "pro" || tier === "family" ? "Family" : "Premium";
    const expiryStr = expiresAt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const frontendUrl = process.env.FRONTEND_URL || "https://CaloVie.app";

    const body = `
      <h2>🚨 Chỉ còn 3 ngày — Gói ${tierLabel} sắp hết hạn!</h2>
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Gói <strong>${tierLabel}</strong> của bạn sẽ hết hạn vào ngày <strong>${expiryStr}</strong>. Chỉ còn <strong>3 ngày</strong> để gia hạn!</p>
      <div class="info-box">
        <div class="row"><span class="label">Gói hiện tại</span><span>${tierLabel}</span></div>
        <div class="row"><span class="label">Hết hạn lúc</span><span>${expiryStr}</span></div>
        <div class="row"><span class="label">Còn lại</span><span><strong style="color:#dc2626">3 ngày</strong></span></div>
      </div>
      <div class="warn-box">
        ⚠️ Nếu không gia hạn, toàn bộ tính năng nâng cao sẽ bị tắt ngay sau <strong>${expiryStr}</strong>.
      </div>
      <a href="${frontendUrl}/subscription" class="btn">Gia hạn ngay →</a>
    `;

    await getTransporter().sendMail({
        from: FROM(),
        to,
        subject: `🚨 Còn 3 ngày — Gói ${tierLabel} sắp hết hạn vào ${expiryStr}`,
        html: layout(`Còn 3 ngày — Gia hạn ${tierLabel}`, body),
    });
}

// ── Email: subscription expired ───────────────────────────────────────────────

export async function sendSubscriptionExpired(opts: {
    to: string;
    name: string;
    tier: string;
}): Promise<void> {
    const { to, name, tier } = opts;
    const tierLabel = tier === "pro" || tier === "family" ? "Family" : "Premium";
    const frontendUrl = process.env.FRONTEND_URL || "https://CaloVie.app";

    const body = `
      <h2>Gói ${tierLabel} của bạn đã hết hạn</h2>
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Gói <strong>${tierLabel}</strong> của bạn đã hết hạn và tài khoản đã được chuyển về gói <strong>Free</strong>.</p>
      <div class="expired-box">
        ❌ Các tính năng đã bị hạn chế:<br/>
        <ul style="margin:8px 0 0; padding-left:20px;">
          <li>Scan AI: Giảm về 3 lần/ngày</li>
          <li>Không còn truy cập thực đơn cộng đồng nâng cao</li>
          <li>Một số tính năng phân tích dinh dưỡng bị tắt</li>
        </ul>
      </div>
      <p>Đăng ký lại ngay để khôi phục toàn bộ tính năng và tiếp tục hành trình dinh dưỡng của bạn:</p>
      <a href="${frontendUrl}/subscription" class="btn">Đăng ký lại →</a>
      <p style="margin-top:24px; font-size:13px; color:#9ca3af;">
        Nếu bạn đã thanh toán nhưng chưa được kích hoạt, vui lòng liên hệ hỗ trợ.
      </p>
    `;

    await getTransporter().sendMail({
        from: FROM(),
        to,
        subject: `📭 Gói ${tierLabel} đã hết hạn — Đăng ký lại để tiếp tục`,
        html: layout(`Gói ${tierLabel} đã hết hạn`, body),
    });
}

// ── Email: payment confirmed ───────────────────────────────────────────────────

export async function sendPaymentConfirmed(opts: {
    to: string;
    name: string;
    tier: string;
    durationMonths: number;
    amount: number;
    expiresAt: Date;
}): Promise<void> {
    const { to, name, tier, durationMonths, amount, expiresAt } = opts;
    const tierLabel = tier === "pro" || tier === "family" ? "Family" : "Premium";
    const expiryStr = expiresAt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const amountStr = amount.toLocaleString("vi-VN") + "₫";

    const body = `
      <h2>Thanh toán thành công! 🎉</h2>
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Gói <strong>${tierLabel}</strong> của bạn đã được kích hoạt thành công. Cảm ơn bạn đã tin tưởng CaloVie!</p>
      <div class="info-box">
        <div class="row"><span class="label">Gói đăng ký</span><span>${tierLabel}</span></div>
        <div class="row"><span class="label">Thời hạn</span><span>${durationMonths} tháng</span></div>
        <div class="row"><span class="label">Số tiền</span><span>${amountStr}</span></div>
        <div class="row"><span class="label">Hạn đến ngày</span><span><strong>${expiryStr}</strong></span></div>
      </div>
      <p>Bạn có thể bắt đầu sử dụng toàn bộ tính năng ngay bây giờ. Chúc bạn có hành trình dinh dưỡng thật tuyệt vời! 🥗</p>
      <a href="${process.env.FRONTEND_URL || "https://CaloVie.app"}" class="btn">Khám phá ngay →</a>
    `;

    await getTransporter().sendMail({
        from: FROM(),
        to,
        subject: `✅ Kích hoạt gói ${tierLabel} thành công — Chào mừng bạn!`,
        html: layout(`Kích hoạt ${tierLabel} thành công`, body),
    });
}

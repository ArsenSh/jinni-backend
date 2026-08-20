const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

/* Localized strings for the USER-FACING transactional emails (verification,
 * password reset, chat-sessions deleted, account deleted). Language choice:
 * existing users → their saved settings.language (callers pass it); signup →
 * the UI locale the frontend sends. Staff/business emails stay English.
 * Keys mirror the app's six locales; anything unknown falls back to en. */
const EMAIL_I18N = {
    en: {
        explorer: 'Explorer', hello: 'Hello', rights: '© 2026 Jinni AI. All rights reserved.',
        auto: 'This is an automated message, please do not reply.',
        expiry: 'This code will expire in 15 minutes and can only be used once.',
        vSubject: 'Verify Your Email - Jinni', vTitle: 'Welcome to Jinni', vSub: 'Verify your email to get started',
        vIntro: 'We are glad to see you join Jinni. To complete your registration, please enter the verification code below:',
        vCodeLabel: 'Your verification code is:', vEnter: 'Enter this code in the verification form to activate your account.',
        vIgnore: "If you didn't request this code, please ignore this email.",
        rSubject: 'Reset Your Password - Jinni', rTitle: 'Password Reset', rSub: 'Reset your Jinni account password',
        rIntro: 'We received a request to reset your password. Use the code below to create a new password:',
        rCodeLabel: 'Your password reset code is:', rEnter: 'Enter this code along with your new password to reset your account.',
        rIgnore: "If you didn't request this reset, please ignore this email.",
        cSubject: 'Your Chat Sessions Have Been Deleted - Jinni', cSub: 'Chat Sessions Deleted',
        cBody: 'All of your chat sessions have been permanently deleted from Jinni.',
        removedTitle: 'What was removed:', cItems: ['All conversation history', 'All session data'],
        cUntouched: 'Your account and settings remain untouched. You can start fresh conversations anytime.',
        support: 'If you did not perform this action, please contact support immediately.',
        aSubject: 'Your Account Has Been Deleted - Jinni', aSub: 'Account Deleted',
        aBody: 'Your Jinni account has been permanently deleted.',
        aItems: ['Your account and profile', 'All chat sessions and conversation history', 'All preferences and settings', 'All associated data'],
        aPermanent: 'This action is permanent and cannot be undone.'
    },
    ru: {
        explorer: 'Путешественник', hello: 'Здравствуйте', rights: '© 2026 Jinni AI. Все права защищены.',
        auto: 'Это автоматическое сообщение, пожалуйста, не отвечайте на него.',
        expiry: 'Код действителен 15 минут и может быть использован только один раз.',
        vSubject: 'Подтвердите ваш email — Jinni', vTitle: 'Добро пожаловать в Jinni', vSub: 'Подтвердите email, чтобы начать',
        vIntro: 'Рады видеть вас в Jinni. Чтобы завершить регистрацию, введите код подтверждения ниже:',
        vCodeLabel: 'Ваш код подтверждения:', vEnter: 'Введите этот код в форму подтверждения, чтобы активировать аккаунт.',
        vIgnore: 'Если вы не запрашивали этот код, просто проигнорируйте это письмо.',
        rSubject: 'Сброс пароля — Jinni', rTitle: 'Сброс пароля', rSub: 'Сброс пароля аккаунта Jinni',
        rIntro: 'Мы получили запрос на сброс пароля. Используйте код ниже, чтобы создать новый пароль:',
        rCodeLabel: 'Ваш код для сброса пароля:', rEnter: 'Введите этот код вместе с новым паролем.',
        rIgnore: 'Если вы не запрашивали сброс, просто проигнорируйте это письмо.',
        cSubject: 'Ваши чаты удалены — Jinni', cSub: 'Чаты удалены',
        cBody: 'Все ваши чат-сессии были безвозвратно удалены из Jinni.',
        removedTitle: 'Что было удалено:', cItems: ['Вся история переписки', 'Все данные сессий'],
        cUntouched: 'Ваш аккаунт и настройки не затронуты. Вы можете начать новые беседы в любой момент.',
        support: 'Если это сделали не вы, немедленно свяжитесь со службой поддержки.',
        aSubject: 'Ваш аккаунт удалён — Jinni', aSub: 'Аккаунт удалён',
        aBody: 'Ваш аккаунт Jinni был безвозвратно удалён.',
        aItems: ['Аккаунт и профиль', 'Все чаты и история переписки', 'Все предпочтения и настройки', 'Все связанные данные'],
        aPermanent: 'Это действие необратимо.'
    },
    hy: {
        explorer: 'Ճանապարհորդ', hello: 'Բարև', rights: '© 2026 Jinni AI. Բոլոր իրավունքները պաշտպանված են։',
        auto: 'Սա ավտոմատ հաղորդագրություն է, խնդրում ենք չպատասխանել։',
        expiry: 'Կոդը գործում է 15 րոպե և կարող է օգտագործվել միայն մեկ անգամ։',
        vSubject: 'Հաստատեք ձեր email-ը — Jinni', vTitle: 'Բարի գալուստ Jinni', vSub: 'Հաստատեք email-ը՝ սկսելու համար',
        vIntro: 'Ուրախ ենք տեսնել ձեզ Jinni-ում։ Գրանցումն ավարտելու համար մուտքագրեք ստորև նշված հաստատման կոդը՝',
        vCodeLabel: 'Ձեր հաստատման կոդը՝', vEnter: 'Մուտքագրեք այս կոդը հաստատման դաշտում՝ հաշիվն ակտիվացնելու համար։',
        vIgnore: 'Եթե դուք չեք պահանջել այս կոդը, պարզապես անտեսեք այս նամակը։',
        rSubject: 'Գաղտնաբառի վերականգնում — Jinni', rTitle: 'Գաղտնաբառի վերականգնում', rSub: 'Վերականգնեք ձեր Jinni հաշվի գաղտնաբառը',
        rIntro: 'Ստացել ենք գաղտնաբառի վերականգնման հայտ։ Օգտագործեք ստորև նշված կոդը՝ նոր գաղտնաբառ ստեղծելու համար՝',
        rCodeLabel: 'Ձեր վերականգնման կոդը՝', rEnter: 'Մուտքագրեք այս կոդը նոր գաղտնաբառի հետ միասին։',
        rIgnore: 'Եթե դուք չեք պահանջել վերականգնում, պարզապես անտեսեք այս նամակը։',
        cSubject: 'Ձեր զրույցները ջնջվել են — Jinni', cSub: 'Զրույցները ջնջված են',
        cBody: 'Ձեր բոլոր զրույցներն անվերադարձ ջնջվել են Jinni-ից։',
        removedTitle: 'Ինչ է ջնջվել՝', cItems: ['Զրույցների ամբողջ պատմությունը', 'Սեսիաների բոլոր տվյալները'],
        cUntouched: 'Ձեր հաշիվը և կարգավորումները մնացել են անփոփոխ։ Կարող եք ցանկացած պահի սկսել նոր զրույցներ։',
        support: 'Եթե դա դուք չեք արել, անմիջապես կապվեք աջակցության հետ։',
        aSubject: 'Ձեր հաշիվը ջնջվել է — Jinni', aSub: 'Հաշիվը ջնջված է',
        aBody: 'Ձեր Jinni հաշիվն անվերադարձ ջնջվել է։',
        aItems: ['Հաշիվը և պրոֆիլը', 'Բոլոր զրույցներն ու պատմությունը', 'Բոլոր նախապատվությունները և կարգավորումները', 'Բոլոր կապակցված տվյալները'],
        aPermanent: 'Այս գործողությունն անվերադարձ է։'
    },
    fr: {
        explorer: 'Explorateur', hello: 'Bonjour', rights: '© 2026 Jinni AI. Tous droits réservés.',
        auto: 'Ceci est un message automatique, merci de ne pas répondre.',
        expiry: 'Ce code expirera dans 15 minutes et ne peut être utilisé qu\'une seule fois.',
        vSubject: 'Vérifiez votre email — Jinni', vTitle: 'Bienvenue sur Jinni', vSub: 'Vérifiez votre email pour commencer',
        vIntro: 'Nous sommes ravis de vous voir rejoindre Jinni. Pour terminer votre inscription, saisissez le code de vérification ci-dessous :',
        vCodeLabel: 'Votre code de vérification :', vEnter: 'Saisissez ce code dans le formulaire de vérification pour activer votre compte.',
        vIgnore: 'Si vous n\'avez pas demandé ce code, ignorez simplement cet email.',
        rSubject: 'Réinitialisez votre mot de passe — Jinni', rTitle: 'Réinitialisation du mot de passe', rSub: 'Réinitialisez le mot de passe de votre compte Jinni',
        rIntro: 'Nous avons reçu une demande de réinitialisation de votre mot de passe. Utilisez le code ci-dessous pour en créer un nouveau :',
        rCodeLabel: 'Votre code de réinitialisation :', rEnter: 'Saisissez ce code avec votre nouveau mot de passe.',
        rIgnore: 'Si vous n\'avez pas demandé cette réinitialisation, ignorez simplement cet email.',
        cSubject: 'Vos conversations ont été supprimées — Jinni', cSub: 'Conversations supprimées',
        cBody: 'Toutes vos conversations ont été définitivement supprimées de Jinni.',
        removedTitle: 'Ce qui a été supprimé :', cItems: ['Tout l\'historique des conversations', 'Toutes les données de session'],
        cUntouched: 'Votre compte et vos paramètres restent intacts. Vous pouvez démarrer de nouvelles conversations à tout moment.',
        support: 'Si vous n\'êtes pas à l\'origine de cette action, contactez immédiatement le support.',
        aSubject: 'Votre compte a été supprimé — Jinni', aSub: 'Compte supprimé',
        aBody: 'Votre compte Jinni a été définitivement supprimé.',
        aItems: ['Votre compte et votre profil', 'Toutes les conversations et l\'historique', 'Toutes les préférences et tous les paramètres', 'Toutes les données associées'],
        aPermanent: 'Cette action est définitive et irréversible.'
    },
    ar: {
        rtl: true,
        explorer: 'مستكشف', hello: 'مرحباً', rights: '© 2026 Jinni AI. جميع الحقوق محفوظة.',
        auto: 'هذه رسالة تلقائية، يرجى عدم الرد عليها.',
        expiry: 'تنتهي صلاحية هذا الرمز خلال 15 دقيقة ويمكن استخدامه مرة واحدة فقط.',
        vSubject: 'تحقق من بريدك الإلكتروني — Jinni', vTitle: 'مرحباً بك في Jinni', vSub: 'تحقق من بريدك الإلكتروني للبدء',
        vIntro: 'يسعدنا انضمامك إلى Jinni. لإكمال تسجيلك، يرجى إدخال رمز التحقق أدناه:',
        vCodeLabel: 'رمز التحقق الخاص بك:', vEnter: 'أدخل هذا الرمز في نموذج التحقق لتفعيل حسابك.',
        vIgnore: 'إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة.',
        rSubject: 'إعادة تعيين كلمة المرور — Jinni', rTitle: 'إعادة تعيين كلمة المرور', rSub: 'إعادة تعيين كلمة مرور حساب Jinni',
        rIntro: 'تلقينا طلباً لإعادة تعيين كلمة المرور. استخدم الرمز أدناه لإنشاء كلمة مرور جديدة:',
        rCodeLabel: 'رمز إعادة التعيين الخاص بك:', rEnter: 'أدخل هذا الرمز مع كلمة المرور الجديدة.',
        rIgnore: 'إذا لم تطلب إعادة التعيين، يرجى تجاهل هذه الرسالة.',
        cSubject: 'تم حذف محادثاتك — Jinni', cSub: 'تم حذف المحادثات',
        cBody: 'تم حذف جميع محادثاتك نهائياً من Jinni.',
        removedTitle: 'ما تم حذفه:', cItems: ['كل سجل المحادثات', 'كل بيانات الجلسات'],
        cUntouched: 'حسابك وإعداداتك لم يتأثرا. يمكنك بدء محادثات جديدة في أي وقت.',
        support: 'إذا لم تقم بهذا الإجراء، يرجى التواصل مع الدعم فوراً.',
        aSubject: 'تم حذف حسابك — Jinni', aSub: 'تم حذف الحساب',
        aBody: 'تم حذف حساب Jinni الخاص بك نهائياً.',
        aItems: ['حسابك وملفك الشخصي', 'جميع المحادثات والسجل', 'جميع التفضيلات والإعدادات', 'جميع البيانات المرتبطة'],
        aPermanent: 'هذا الإجراء نهائي ولا يمكن التراجع عنه.'
    },
    zh: {
        explorer: '探索者', hello: '您好', rights: '© 2026 Jinni AI. 保留所有权利。',
        auto: '这是一封自动发送的邮件，请勿回复。',
        expiry: '此验证码将在 15 分钟后失效，且只能使用一次。',
        vSubject: '验证您的邮箱 — Jinni', vTitle: '欢迎来到 Jinni', vSub: '验证邮箱即可开始使用',
        vIntro: '很高兴您加入 Jinni。请输入以下验证码以完成注册：',
        vCodeLabel: '您的验证码是：', vEnter: '请在验证表单中输入此验证码以激活您的账户。',
        vIgnore: '如果您没有请求此验证码，请忽略此邮件。',
        rSubject: '重置您的密码 — Jinni', rTitle: '密码重置', rSub: '重置您的 Jinni 账户密码',
        rIntro: '我们收到了重置密码的请求。请使用以下验证码创建新密码：',
        rCodeLabel: '您的密码重置码是：', rEnter: '请输入此验证码和您的新密码。',
        rIgnore: '如果您没有请求重置密码，请忽略此邮件。',
        cSubject: '您的聊天记录已删除 — Jinni', cSub: '聊天记录已删除',
        cBody: '您在 Jinni 的所有聊天会话已被永久删除。',
        removedTitle: '已删除的内容：', cItems: ['所有对话历史', '所有会话数据'],
        cUntouched: '您的账户和设置未受影响，您可以随时开始新的对话。',
        support: '如果这不是您本人的操作，请立即联系客服。',
        aSubject: '您的账户已删除 — Jinni', aSub: '账户已删除',
        aBody: '您的 Jinni 账户已被永久删除。',
        aItems: ['您的账户和个人资料', '所有聊天会话和对话历史', '所有偏好和设置', '所有相关数据'],
        aPermanent: '此操作是永久性的，无法撤销。'
    }
};
function emailLang(language) {
    const code = String(language || 'en').toLowerCase().slice(0, 2);
    return EMAIL_I18N[code] || EMAIL_I18N.en;
}

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_APP_PASSWORD
            }
        });
    }
    async sendVerificationEmail(email, code, name, language) {
        const L = emailLang(language);
        const dir = L.rtl ? 'rtl' : 'ltr';
        try {
            const mailOptions = {
                from: `"Jinni AI" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: L.vSubject,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 28px; }
                            .content { padding: 40px 30px; text-align: center; }
                            .code-container { background: #f8f9fa; border: 2px dashed #D4AF37; border-radius: 10px; padding: 30px; margin: 30px 0; }
                            .code { font-size: 36px; font-weight: bold; color: #D4AF37; letter-spacing: 8px; margin: 10px 0; }
                            .warning { color: #dc3545; font-size: 14px; margin-top: 20px; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                        </style>
                    </head>
                    <body dir="${dir}">
                        <div class="container">
                            <div class="header">
                                <h1>${L.vTitle}</h1>
                                <p>${L.vSub}</p>
                            </div>
                            <div class="content">
                                <h2>${L.hello} ${name || L.explorer}!</h2>
                                <p>${L.vIntro}</p>
                                <div class="code-container">
                                    <p>${L.vCodeLabel}</p>
                                    <div class="code">${code}</div>
                                </div>
                                <p>${L.vEnter}</p>
                                <p class="warning">${L.expiry}</p>
                                <p class="warning">${L.vIgnore}</p>
                            </div>
                            <div class="footer">
                                <p>${L.rights}</p>
                                <p>${L.auto}</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
                text: `
${L.vTitle}
${L.hello} ${name || L.explorer}!
${L.vCodeLabel} ${code}
${L.expiry}
${L.vEnter}
${L.vIgnore}
${L.rights}
                `
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Verification email sent to ${email}. Message ID: ${result.messageId}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send verification email:', error);
            throw new Error('Failed to send verification email');
        }
    }
    async sendPasswordResetEmail(email, code, name, language) {
        const L = emailLang(language);
        const dir = L.rtl ? 'rtl' : 'ltr';
        try {
            const mailOptions = {
                from: `"Jinni AI" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: L.rSubject,
                html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                        .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                        .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                        .header h1 { margin: 0; font-size: 28px; }
                        .content { padding: 40px 30px; text-align: center; }
                        .code-container { background: #f8f9fa; border: 2px dashed #D4AF37; border-radius: 10px; padding: 30px; margin: 30px 0; }
                        .code { font-size: 36px; font-weight: bold; color: #D4AF37; letter-spacing: 8px; margin: 10px 0; }
                        .warning { color: #dc3545; font-size: 14px; margin-top: 20px; }
                        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    </style>
                </head>
                <body dir="${dir}">
                    <div class="container">
                        <div class="header">
                            <h1>${L.rTitle}</h1>
                            <p>${L.rSub}</p>
                        </div>
                        <div class="content">
                            <h2>${L.hello} ${name || L.explorer}!</h2>
                            <p>${L.rIntro}</p>
                            <div class="code-container">
                                <p>${L.rCodeLabel}</p>
                                <div class="code">${code}</div>
                            </div>
                            <p>${L.rEnter}</p>
                            <p class="warning">${L.expiry}</p>
                            <p class="warning">${L.rIgnore}</p>
                        </div>
                        <div class="footer">
                            <p>${L.rights}</p>
                            <p>${L.auto}</p>
                        </div>
                    </div>
                </body>
                </html>
            `,
                text: `
${L.rTitle}
${L.hello} ${name || L.explorer}!
${L.rCodeLabel} ${code}
${L.expiry}
${L.rEnter}
${L.rIgnore}
${L.rights}
            `
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Password reset email sent to ${email}. Message ID: ${result.messageId}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send password reset email:', error);
            throw new Error('Failed to send password reset email');
        }
    }
    async sendChatSessionsDeletedEmail(email, name, language) {
        const L = emailLang(language);
        const dir = L.rtl ? 'rtl' : 'ltr';
        try {
            const mailOptions = {
                from: `"Jinni AI" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: L.cSubject,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 28px; }
                            .content { padding: 40px 30px; text-align: center; }
                            .icon-box { font-size: 48px; margin: 20px 0; }
                            .info-box { background: #f8f9fa; border: none; border-radius: 10px; padding: 20px; margin: 25px 0; text-align: left; }
                            .info-box p { margin: 8px 0; font-size: 14px; color: #495057; }
                            .warning { color: #dc3545; font-size: 14px; margin-top: 20px; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                        </style>
                    </head>
                    <body dir="${dir}">
                        <div class="container">
                            <div class="header">
                                <h1>Jinni</h1>
                                <p>${L.cSub}</p>
                            </div>
                            <div class="content">
                                <div class="icon-box">🗑️</div>
                                <h2>${L.hello} ${name || L.explorer}</h2>
                                <p>${L.cBody}</p>
                                <div class="info-box">
                                    <p><strong>${L.removedTitle}</strong></p>
                                    ${L.cItems.map(i => `<p>• ${i}</p>`).join('\n                                    ')}
                                </div>
                                <p>${L.cUntouched}</p>
                                <p class="warning">${L.support}</p>
                            </div>
                            <div class="footer">
                                <p>${L.rights}</p>
                                <p>${L.auto}</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
                text: `
${L.cSub} - Jinni

${L.hello} ${name || L.explorer}

${L.cBody}

${L.removedTitle}
${L.cItems.map(i => `- ${i}`).join('\n')}

${L.cUntouched}

${L.support}

${L.rights}
                `
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Chat sessions deleted email sent to ${email}. Message ID: ${result.messageId}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send chat sessions deleted email:', error);
            throw new Error('Failed to send chat sessions deleted email');
        }
    }
    async sendAccountDeletedEmail(email, name, language) {
        const L = emailLang(language);
        const dir = L.rtl ? 'rtl' : 'ltr';
        try {
            const mailOptions = {
                from: `"Jinni AI" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: L.aSubject,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #b91c1c, #dc2626); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 28px; }
                            .content { padding: 40px 30px; text-align: center; }
                            .icon-box { font-size: 48px; margin: 20px 0; }
                            .info-box { background: #fff5f5; border: none; border-radius: 10px; padding: 20px; margin: 25px 0; text-align: left; }
                            .info-box p { margin: 8px 0; font-size: 14px; color: #991b1b; }
                            .warning { color: #dc3545; font-size: 14px; margin-top: 20px; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                        </style>
                    </head>
                    <body dir="${dir}">
                        <div class="container">
                            <div class="header">
                                <h1>Jinni</h1>
                                <p>${L.aSub}</p>
                            </div>
                            <div class="content">
                                <div class="icon-box">🔒</div>
                                <h2>${L.hello} ${name || L.explorer}</h2>
                                <p>${L.aBody}</p>
                                <div class="info-box">
                                    <p><strong>${L.removedTitle}</strong></p>
                                    ${L.aItems.map(i => `<p>• ${i}</p>`).join('\n                                    ')}
                                </div>
                                <p>${L.aPermanent}</p>
                                <p class="warning">${L.support}</p>
                            </div>
                            <div class="footer">
                                <p>${L.rights}</p>
                                <p>${L.auto}</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
                text: `
${L.aSub} - Jinni

${L.hello} ${name || L.explorer},

${L.aBody}

${L.removedTitle}
${L.aItems.map(i => `- ${i}`).join('\n')}

${L.aPermanent}

${L.support}

${L.rights}
                `
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Account deleted email sent to ${email}. Message ID: ${result.messageId}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send account deleted email:', error);
            throw new Error('Failed to send account deleted email');
        }
    }
    /**
     * Tier badge for HTML emails — mirrors the onboarding/landing page badges
     * (.verified/.spotlight/.signature-badge-display). Email clients strip
     * <svg>, so the app's icons become unicode glyphs; colors are identical.
     * Solid rgba backgrounds (the gradients' first stop) — gradient support
     * in email clients is unreliable.
     */
    tierBadge(tier) {
        const t = {
            verified:  { label: 'Jinni Verified',  glyph: '✓', bg: 'rgba(46, 204, 113, 0.15)', color: '#27ae60' },
            spotlight: { label: 'Jinni Spotlight', glyph: '☀', bg: 'rgba(74, 144, 226, 0.15)', color: '#3b9edd' },
            signature: { label: 'Jinni Signature', glyph: '✦', bg: 'rgba(212, 175, 55, 0.15)', color: '#FF8C00' },
        }[tier] || { label: 'Jinni Verified', glyph: '✓', bg: 'rgba(46, 204, 113, 0.15)', color: '#27ae60' }
        return {
            ...t,
            html: `<div style="display:inline-block;background:${t.bg};color:${t.color};border-radius:20px;padding:6px 16px;font-size:14px;font-weight:600;margin:16px 0">${t.glyph} ${t.label}</div>`
        }
    }

    async sendBusinessApprovedEmail(email, businessName, tier) {
        try {
            const badge = this.tierBadge(tier)
            const tierLabel = badge.label
            const mailOptions = {
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `🎉 Your listing is live — ${businessName}`,
                html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8">
                    <style>
                        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                        .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                        .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                        .header h1 { margin: 0; font-size: 28px; }
                        .content { padding: 40px 30px; }
                        .cta { display: inline-block; background: linear-gradient(45deg, #D4AF37, #FF8C00); color: white; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; margin: 24px 0; }
                        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    </style></head><body>
                    <div class="container">
                        <div class="header"><h1>You're live on Jinni! 🎉</h1><p>Your listing has been approved and activated</p></div>
                        <div class="content">
                            <h2>Congratulations!</h2>
                            <p><strong>${businessName}</strong> has been verified and is now visible to travelers on Jinni.</p>
                            ${badge.html}
                            <p>Travelers can now discover your business, save it to their lists, and get directions to your location.</p>
                            <p>Log in to your business dashboard to view your listing and track performance.</p>
                            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">Go to Dashboard</a>
                        </div>
                        <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p></div>
                    </div></body></html>
                `,
                text: `Congratulations! ${businessName} is now live on Jinni as ${tierLabel}. Log in at ${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth to view your dashboard.`
            }
            const result = await this.transporter.sendMail(mailOptions)
            logger.info(`Business approved email sent to ${email}`)
            return { success: true, messageId: result.messageId }
        } catch (error) {
            logger.error('Failed to send business approved email:', error)
            throw error
        }
    }

    /**
     * Send the "application approved, on the waitlist" email to a Signature
     * business that has entered the Zone Auction.
     *
     * Signature change history: this used to take `(email, businessName, tier,
     * earliestExpiry)` as a flat 4-arg list. Every caller passed the auction
     * `highBid` (a dollar amount, e.g. 55) as the 4th argument, which then
     * got interpreted as `earliestExpiry` and fed into `new Date(55)` →
     * January 1, 1970. That was the source of the "earliest slot may open
     * around January 1, 1970" bug.
     *
     * The signature is now `(email, businessName, tier, opts)` where opts is
     * `{ earliestExpiry, currentHighBid }`. We also keep a backwards-compat
     * shim so old callers that pass a single primitive (Date / ISO string /
     * number) as the 4th arg still work — a Date or ISO string is treated as
     * `earliestExpiry`, a finite small number is treated as `currentHighBid`
     * (auction bids are dollar amounts, not millisecond timestamps).
     *
     * `earliestExpiry` is validated: only finite, post-epoch dates are
     * rendered into the email. Anything else falls back to the generic
     * "we'll notify you" line — never an epoch date.
     */
    async sendBusinessWaitlistedEmail(email, businessName, tier, opts = {}) {
        try {
            // ── Backwards-compat shim ────────────────────────────────────
            // If a non-object was passed (old call shape), figure out which
            // field it was meant to be. A Date or ISO-string is an expiry; a
            // small number is a bid; anything else we ignore.
            let earliestExpiry = null
            let currentHighBid = null
            if (opts instanceof Date || typeof opts === 'string') {
                earliestExpiry = opts
            } else if (typeof opts === 'number') {
                // No real timestamp is going to be < year 2001 in ms (≈10^12).
                // Anything smaller is almost certainly a dollar amount that an
                // old caller stuck into the expiry slot — interpret as bid.
                currentHighBid = opts
            } else if (opts && typeof opts === 'object') {
                earliestExpiry = opts.earliestExpiry ?? null
                currentHighBid = opts.currentHighBid ?? null
            }

            // ── Expiry text — validated, never epoch ─────────────────────
            // new Date(null) → Invalid Date; new Date(0) → 1970. Reject both.
            // We require a real Date or parseable string that resolves to a
            // timestamp strictly after the Unix epoch.
            let expiryText = 'We will notify you as soon as a slot opens.'
            if (earliestExpiry != null && earliestExpiry !== '') {
                const d = earliestExpiry instanceof Date ? earliestExpiry : new Date(earliestExpiry)
                if (!Number.isNaN(d.getTime()) && d.getTime() > 0) {
                    const formatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                    expiryText = `The earliest slot may open around <strong>${formatted}</strong>.`
                }
            }

            // ── High-bid text — only rendered when we have a real number ─
            const bidText = (typeof currentHighBid === 'number' && currentHighBid > 0)
                ? `<p>Current high bid in this zone's auction: <strong>$${currentHighBid}/mo</strong>.</p>`
                : ''

            const mailOptions = {
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `${businessName} — application approved, on the waitlist`,
                html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8">
                    <style>
                        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                        .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                        .header { background: linear-gradient(45deg, #3b82f6, #6366f1); padding: 30px; text-align: center; color: white; }
                        .header h1 { margin: 0; font-size: 26px; }
                        .content { padding: 40px 30px; }
                        .info-box { background: #f0f9ff; border: none; border-radius: 10px; padding: 20px; margin: 20px 0; }
                        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    </style></head><body>
                    <div class="container">
                        <div class="header"><h1>Application approved ✓</h1><p>You're on the waitlist for your zone</p></div>
                        <div class="content">
                            <h2>Good news — your application passed review!</h2>
                            <p><strong>${businessName}</strong> has been verified and approved. However, your zone currently has no available slots.</p>
                            ${this.tierBadge(tier).html}
                            <div class="info-box">
                                <p><strong>What happens next:</strong></p>
                                <p>• Your listing is queued and ready to go live</p>
                                <p>• You will receive an email the moment a slot opens</p>
                                <p>• ${expiryText}</p>
                            </div>
                            ${bidText}
                            <p>No action needed from you — we'll handle it automatically.</p>
                        </div>
                        <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p></div>
                    </div></body></html>
                `,
                text: `Good news — ${businessName} has been approved! Your zone is currently full but you're on the waitlist. ${expiryText.replace(/<\/?strong>/g, '')} We'll email you when a slot opens.`
            }
            const result = await this.transporter.sendMail(mailOptions)
            logger.info(`Business waitlisted email sent to ${email}`)
            return { success: true, messageId: result.messageId }
        } catch (error) {
            logger.error('Failed to send business waitlisted email:', error)
            throw error
        }
    }

    async sendRejectionEmail(email, businessName, reason, businessId = null, options = {}) {
        try {
            const { permanent = false } = options;
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            // Deep-link to dashboard's edit tab. We do NOT route back to /apply
            // any more — the resubmit flow is now "edit in place," and creating
            // a fresh application creates a duplicate.
            const dashboardUrl = businessId
                ? `${frontendUrl}/business/dashboard?tab=edit`
                : `${frontendUrl}/business/dashboard`;

            // ── PERMANENT (hard) rejection ───────────────────────────────────
            // No "fix and resubmit" CTA — the listing can't be resubmitted. We
            // keep the copy neutral and do NOT reveal that fingerprints were
            // blocked (that would be an evasion roadmap). The owner is pointed
            // at support in case of a genuine mistake.
            if (permanent) {
                const mailOptions = {
                    from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                    to: email,
                    subject: `Update on your Jinni listing — ${businessName}`,
                    html: `
                        <!DOCTYPE html><html><head><meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #64748b, #475569); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 26px; }
                            .content { padding: 40px 30px; }
                            .reason-box { background: #fafafa; border-left: 4px solid #94a3b8; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #444; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                        </style></head><body>
                        <div class="container">
                            <div class="header"><h1>Listing review update</h1><p>${businessName}</p></div>
                            <div class="content">
                                <h2>We were unable to approve your listing</h2>
                                <p>After reviewing your application for <strong>${businessName}</strong>, our team is unable to approve it for listing on Jinni.</p>
                                <div class="reason-box"><strong>Reason:</strong><br>${reason || 'Your application did not meet our verification requirements.'}</div>
                                <p>If you believe this decision was made in error, please reply to this email and our support team will review it.</p>
                            </div>
                            <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p></div>
                        </div></body></html>
                    `,
                    text:
                        `Update on ${businessName}:\n\n` +
                        `We were unable to approve your listing.\n\n` +
                        `Reason: ${reason || 'Did not meet verification requirements.'}\n\n` +
                        `If you believe this decision was made in error, please reply to this email and our support team will review it.\n`
                };
                const result = await this.transporter.sendMail(mailOptions);
                logger.info(`Permanent-rejection email sent to ${email}`);
                return { success: true, messageId: result.messageId };
            }

            const mailOptions = {
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Update on your Jinni listing — ${businessName}`,
                html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8">
                    <style>
                        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                        .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                        .header { background: linear-gradient(45deg, #64748b, #475569); padding: 30px; text-align: center; color: white; }
                        .header h1 { margin: 0; font-size: 26px; }
                        .content { padding: 40px 30px; }
                        .reason-box { background: #fafafa; border-left: 4px solid #D4AF37; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #444; }
                        .cta-btn { display: inline-block; margin: 24px 0 8px; padding: 14px 32px; background: linear-gradient(45deg, #D4AF37, #FF8C00); color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: bold; }
                        .next-steps { margin: 18px 0 0; padding: 12px 14px; background: #f8fafc; border-radius: 8px; font-size: 13px; color: #475569; }
                        .next-steps ul { margin: 6px 0 0; padding-left: 18px; }
                        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    </style></head><body>
                    <div class="container">
                        <div class="header"><h1>Listing review update</h1><p>${businessName}</p></div>
                        <div class="content">
                            <h2>We were unable to approve your listing</h2>
                            <p>After reviewing your application for <strong>${businessName}</strong>, our team was unable to verify and approve it at this time.</p>
                            <div class="reason-box"><strong>Reason:</strong><br>${reason || 'Your application did not meet our verification requirements.'}</div>

                            <p>You can <strong>update the information</strong> the reviewer flagged and resubmit — your listing will go back into review.</p>
                            <p style="text-align:center;">
                                <a href="${dashboardUrl}" class="cta-btn">Fix and resubmit</a>
                            </p>

                            <div class="next-steps">
                                <strong>What to do next:</strong>
                                <ul>
                                    <li>Sign in to your dashboard.</li>
                                    <li>Open the <em>Edit listing</em> tab.</li>
                                    <li>Update the field(s) the reviewer mentioned and save.</li>
                                    <li>Your changes will return to <em>pending</em> for re-review.</li>
                                </ul>
                                <p style="margin: 10px 0 0; font-size: 12px; color: #64748b;">
                                    Please don't submit a new application — that creates a duplicate. The Fix &amp; Resubmit button on your dashboard updates this listing in place.
                                </p>
                            </div>

                            <p style="margin-top: 20px;">If you believe this is an error, reply to this email and our support team will look into it.</p>
                        </div>
                        <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p></div>
                    </div></body></html>
                `,
                text:
                    `Update on ${businessName}:\n\n` +
                    `We were unable to approve your listing.\n\n` +
                    `Reason: ${reason || 'Did not meet verification requirements.'}\n\n` +
                    `To fix and resubmit:\n` +
                    `  1. Sign in: ${dashboardUrl}\n` +
                    `  2. Open the Edit listing tab\n` +
                    `  3. Update the flagged field(s) and save\n` +
                    `  4. Your listing will return to pending for re-review\n\n` +
                    `Please don't submit a new application — that creates a duplicate.\n`
            }
            const result = await this.transporter.sendMail(mailOptions)
            logger.info(`Rejection email sent to ${email}`)
            return { success: true, messageId: result.messageId }
        } catch (error) {
            logger.error('Failed to send rejection email:', error)
            throw error
        }
    }

    // Sent when an admin downgrades a PERMANENT (hard) rejection back to a soft
    // one — the owner can now edit + resubmit again. Mirrors the soft-rejection
    // copy's "fix and resubmit" CTA.
    async sendRejectionDowngradedEmail(email, businessName, note, businessId = null) {
        try {
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            const dashboardUrl = businessId
                ? `${frontendUrl}/business/dashboard?tab=edit`
                : `${frontendUrl}/business/dashboard`;
            const mailOptions = {
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Your Jinni listing can be resubmitted — ${businessName}`,
                html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8">
                    <style>
                        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                        .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                        .header { background: linear-gradient(45deg, #0ea5e9, #2563eb); padding: 30px; text-align: center; color: white; }
                        .header h1 { margin: 0; font-size: 26px; }
                        .content { padding: 40px 30px; }
                        .reason-box { background: #fafafa; border-left: 4px solid #0ea5e9; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #444; }
                        .cta-btn { display: inline-block; margin: 24px 0 8px; padding: 14px 32px; background: linear-gradient(45deg, #0ea5e9, #2563eb); color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: bold; }
                        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    </style></head><body>
                    <div class="container">
                        <div class="header"><h1>Good news</h1><p>${businessName}</p></div>
                        <div class="content">
                            <h2>Your listing can be resubmitted</h2>
                            <p>We've re-opened your listing for <strong>${businessName}</strong>. You can now update the information and resubmit it for review.</p>
                            ${note ? `<div class="reason-box"><strong>Note from our team:</strong><br>${note}</div>` : ''}
                            <p style="text-align:center;">
                                <a href="${dashboardUrl}" class="cta-btn">Edit and resubmit</a>
                            </p>
                        </div>
                        <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p></div>
                    </div></body></html>
                `,
                text:
                    `Good news for ${businessName}:\n\n` +
                    `Your listing has been re-opened and can be resubmitted.\n\n` +
                    (note ? `Note from our team: ${note}\n\n` : '') +
                    `Edit and resubmit: ${dashboardUrl}\n`
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Rejection-downgrade email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send rejection-downgrade email:', error);
            throw error;
        }
    }

    async sendBusinessSetupEmail(email, name, businessName, setupUrl) {
        try {
            const mailOptions = {
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: 'Set Up Your Jinni Business Account',
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 28px; }
                            .content { padding: 40px 30px; text-align: center; }
                            .cta-btn { display: inline-block; margin: 28px 0; padding: 16px 36px; background: linear-gradient(45deg, #D4AF37, #FF8C00); color: white; text-decoration: none; border-radius: 10px; font-size: 16px; font-weight: bold; }
                            .note { color: #888; font-size: 13px; margin-top: 16px; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>Welcome to Jinni Business</h1>
                                <p>Your application has been received</p>
                            </div>
                            <div class="content">
                                <h2>Hello ${name}!</h2>
                                <p>Thank you for submitting <strong>${businessName}</strong> to Jinni. Our team will review your application within 24 hours.</p>
                                <p>To access your business dashboard, please set a password for your account by clicking the button below:</p>
                                <a href="${setupUrl}" class="cta-btn">Set My Password</a>
                                <p class="note">This link expires in 24 hours and can only be used once.<br>If you did not submit this application, you can safely ignore this email.</p>
                            </div>
                            <div class="footer">
                                <p>© 2026 Jinni AI. All rights reserved.</p>
                                <p>This is an automated message — do not reply.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
                text: `
    Welcome to Jinni Business!

    Hello ${name},

    Thank you for submitting "${businessName}" to Jinni. Our team will review your application within 24 hours.

    To access your business dashboard, set your password here:
    ${setupUrl}

    This link expires in 24 hours and can only be used once.

    © 2026 Jinni
                `
            }
            const result = await this.transporter.sendMail(mailOptions)
            logger.info(`Business setup email sent to ${email}. Message ID: ${result.messageId}`)
            return { success: true, messageId: result.messageId }
        } catch (error) {
            logger.error('Failed to send business setup email:', error)
            throw new Error('Failed to send business setup email')
        }
    }
    
    async sendStaffCredentialsEmail(email, name, tempPassword, permissions = {}) {
        try {
            // Marketing-only accounts get marketing wording — a "validate
            // businesses" welcome makes no sense to a marketing partner.
            const isMarketing = !!permissions.viewMarketing && !permissions.validateBusinesses
                && !permissions.manageDestinations && !permissions.moderateExplore;
            const roleHeadline = isMarketing ? 'Your marketing dashboard account is ready' : 'Your validation account is ready';
            const roleIntro = isMarketing
                ? "An admin has created a Jinni account for you. After signing in you'll land on the Growth &amp; Retention dashboard — live user, retention and usage numbers for Jinni."
                : 'An admin has created a Jinni staff account for you. You can use this account to review and validate business applications.';
            const roleIntroText = isMarketing
                ? "An admin has created a Jinni account for you. After signing in you'll land on the Growth & Retention dashboard — live user, retention and usage numbers for Jinni."
                : 'An admin has created a Jinni staff account for you. You can use this account to review and validate business applications.';
            const contactEmail = process.env.SUPPORT_EMAIL || process.env.EMAIL_USER;
            const loginUrl = (process.env.FRONTEND_URL || 'https://jinni.travel').replace(/\/$/, '') + '/auth';
            const mailOptions = {
                from: `"Jinni" <${process.env.EMAIL_USER}>`,
                to: email,
                // No "password"/"credentials" words in the subject — those are
                // classic spam-filter triggers on top of a gmail.com sender.
                subject: isMarketing ? 'Your Jinni marketing account is ready' : 'Your Jinni staff account is ready',
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                            .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                            .header h1 { margin: 0; font-size: 26px; }
                            .header p { margin: 6px 0 0; opacity: 0.95; font-size: 14px; }
                            .content { padding: 36px 30px; color: #333; }
                            .content h2 { margin: 0 0 12px; font-size: 20px; }
                            .content p { line-height: 1.6; font-size: 14px; }
                            .creds-box { background: #f8f9fa; border: 2px dashed #D4AF37; border-radius: 10px; padding: 20px 22px; margin: 24px 0; }
                            .creds-row { display: table; width: 100%; padding: 6px 0; font-size: 14px; }
                            .creds-label { display: table-cell; color: #888; font-weight: 600; width: 110px; text-transform: uppercase; font-size: 12px; letter-spacing: 0.06em; vertical-align: top; }
                            .creds-value { display: table-cell; font-family: 'Menlo', 'Consolas', monospace; font-size: 15px; color: #333; word-break: break-all; }
                            .cta-btn { display: inline-block; background: linear-gradient(45deg, #D4AF37, #FF8C00); color: white !important; text-decoration: none; padding: 12px 28px; border-radius: 10px; font-weight: 600; font-size: 14px; margin: 8px 0 4px; }
                            .recommendation { color: #b45309; font-size: 13.5px; margin-top: 22px; padding: 14px 16px; background: #fff7e8; border-radius: 8px; line-height: 1.6; border-left: 4px solid #f59e0b; }
                            .recommendation strong { color: #92400e; }
                            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
                            .info-line { font-size: 13px; color: #666; margin-top: 18px; line-height: 1.55; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>Welcome to Jinni</h1>
                                <p>${roleHeadline}</p>
                            </div>
                            <div class="content">
                                <h2>Hello ${name || 'there'},</h2>
                                <p>${roleIntro}</p>
                                <div class="creds-box">
                                    <div class="creds-row">
                                        <div class="creds-label">Email</div>
                                        <div class="creds-value">${email}</div>
                                    </div>
                                    <div class="creds-row">
                                        <div class="creds-label">Password</div>
                                        <div class="creds-value">${tempPassword}</div>
                                    </div>
                                </div>
                                <p style="text-align:center; margin-top: 8px">
                                    <a class="cta-btn" href="${loginUrl}">Sign in to Jinni</a>
                                </p>
                                <div class="recommendation">
                                    <strong>We strongly recommend changing your password immediately.</strong>
                                    Note: your workspace page has <strong>no password settings</strong> — the only way to change it is on the <em>sign-in page</em>: tap <em>"Forgot password?"</em>, and a reset code will arrive at this email address.
                                </div>
                                <p class="info-line">
                                    If you didn't expect this account, please ignore this email and contact us at ${contactEmail}. The account stays dormant until first use.
                                </p>
                            </div>
                            <div class="footer">
                                <p>© 2026 Jinni AI. All rights reserved.</p>
                                <p>This is an automated message — do not reply.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
                text: `
Welcome to Jinni

Hello ${name || 'there'},

${roleIntroText}

Email:    ${email}
Password: ${tempPassword}

Sign in here: ${loginUrl}

WE STRONGLY RECOMMEND CHANGING YOUR PASSWORD IMMEDIATELY.
Note: your workspace page has NO password settings — the only way to change
it is on the SIGN-IN page: tap "Forgot password?" and a reset code will
arrive at this email address.

If you didn't expect this account, please ignore this email and contact us
at ${contactEmail}.

© 2026 Jinni AI
                `
            };
            const result = await this.transporter.sendMail(mailOptions);
            logger.info(`Staff credentials email sent to ${email}. Message ID: ${result.messageId}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send staff credentials email:', error);
            throw new Error('Failed to send staff credentials email');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ZONE AUCTION EMAILS
    // Called by services/zoneAuction.js. See plan.txt → "Zone Auction".
    // All are best-effort: zoneAuction wraps each call and never lets a failed
    // email break an auction flow.
    // ─────────────────────────────────────────────────────────────────────────

    // Shared header/footer styling, gold auction theme.
    _auctionShell(headerTitle, headerSub, innerHtml) {
        return `
            <!DOCTYPE html><html><head><meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); margin: 0; padding: 20px; }
                .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                .header { background: linear-gradient(45deg, #D4AF37, #FF8C00); padding: 30px; text-align: center; color: white; }
                .header h1 { margin: 0; font-size: 26px; }
                .content { padding: 40px 30px; }
                .info-box { background: #fffbeb; border: none; border-radius: 10px; padding: 20px; margin: 20px 0; }
                .alert-box { background: #fef2f2; border: none; border-radius: 10px; padding: 20px; margin: 20px 0; }
                .bid { font-size: 30px; font-weight: 800; color: #c09930; margin: 8px 0; }
                .cta { display: inline-block; background: linear-gradient(45deg, #D4AF37, #FF8C00); color: white; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; margin: 24px 0; }
                .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
            </style></head><body>
            <div class="container">
                <div class="header"><h1>${headerTitle}</h1><p>${headerSub}</p></div>
                <div class="content">${innerHtml}</div>
                <div class="footer"><p>© 2026 Jinni AI. All rights reserved.</p><p>This is an automated message — do not reply.</p></div>
            </div></body></html>
        `;
    }

    _fmtDate(d) {
        if (!d) return '';
        try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
        catch { return ''; }
    }

    // 1. A new/raised bid appeared in a sitting Signature's zone.
    async sendAuctionBidUpdate(email, businessName, zoneKey, currentHighBid) {
        if (!email) return { success: false, skipped: true };
        try {
            const inner = `
                <h2>A challenger is bidding on your zone</h2>
                <p>Someone wants the slot held by <strong>${businessName}</strong>. The current high bid in your zone's auction is:</p>
                <div class="bid">$${currentHighBid}/mo</div>
                <div class="info-box">
                    <p><strong>What this means:</strong></p>
                    <p>• Your slot is contested. At your quarterly renewal, the lowest-performing Signature in the zone must beat the high bid to stay.</p>
                    <p>• You'll get a separate email with a 72-hour window to respond if your listing is the one that must defend.</p>
                    <p>• Keeping your performance score high is the best protection.</p>
                </div>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">View Zone Intelligence</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `A challenger is bidding on your zone — ${businessName}`,
                html: this._auctionShell('Zone auction update', 'A new bid was placed in your zone', inner),
                text: `A challenger is bidding on your zone. The current high bid is $${currentHighBid}/mo. At your quarterly renewal the lowest-performing Signature must beat it to keep their slot.`
            });
            logger.info(`Auction bid-update email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction bid-update email:', error);
            throw error;
        }
    }

    // 2. This listing is the lowest performer — it must defend within 72h.
    async sendAuctionDefendNotice(email, businessName, zoneKey, bidToBeat, deadline) {
        if (!email) return { success: false, skipped: true };
        try {
            const inner = `
                <h2>Your slot is up for auction — action needed</h2>
                <p><strong>${businessName}</strong> is currently the lowest-performing Signature listing in its zone, and a challenger has bid for the slot.</p>
                <div class="alert-box">
                    <p><strong>To keep your slot, you must bid more than:</strong></p>
                    <div class="bid">$${bidToBeat}/mo</div>
                    <p>Matching is not enough — your bid must be strictly higher.</p>
                    <p><strong>Deadline: ${this._fmtDate(deadline)}</strong> (72 hours). If you don't respond, the slot goes to the highest bidder and your listing is frozen.</p>
                </div>
                <p>A frozen listing keeps all its analytics and can bid again on a future opening — but it stops being shown to travelers until then.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">Defend My Slot</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `⚠️ Defend your zone slot within 72 hours — ${businessName}`,
                html: this._auctionShell('Defend your slot', 'Your zone slot is being auctioned', inner),
                text: `Action needed: ${businessName} is the lowest-performing Signature in its zone. To keep your slot you must bid strictly more than $${bidToBeat}/mo by ${this._fmtDate(deadline)} (72 hours), or the slot goes to the highest bidder and your listing is frozen.`
            });
            logger.info(`Auction defend-notice email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction defend-notice email:', error);
            throw error;
        }
    }

    // 3. Incumbent successfully defended — slot kept, price locked.
    async sendAuctionDefenseWon(email, businessName, lockedPrice, lockUntil) {
        if (!email) return { success: false, skipped: true };
        try {
            const inner = `
                <h2>You kept your slot ✓</h2>
                <p>Your defense was successful — <strong>${businessName}</strong> keeps its Signature slot.</p>
                <div class="info-box">
                    <p><strong>Your monthly price is now:</strong></p>
                    <div class="bid">$${lockedPrice}/mo</div>
                    <p>This price is locked until <strong>${this._fmtDate(lockUntil)}</strong> — no challenger can contest your slot before then.</p>
                </div>
                <p>Thanks for staying with Jinni. Keep your performance score strong to make future renewals easier.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">Go to Dashboard</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `You kept your zone slot — ${businessName}`,
                html: this._auctionShell('Slot defended ✓', 'Your price is locked for the quarter', inner),
                text: `Your defense was successful — ${businessName} keeps its Signature slot at $${lockedPrice}/mo, locked until ${this._fmtDate(lockUntil)}.`
            });
            logger.info(`Auction defense-won email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction defense-won email:', error);
            throw error;
        }
    }

    // 4. Incumbent forfeited (declined or 72h lapsed) — listing frozen.
    async sendAuctionForfeitNotice(email, businessName, zoneKey, performanceScore) {
        if (!email) return { success: false, skipped: true };
        try {
            const scoreLine = (performanceScore || performanceScore === 0)
                ? `<p>• Your final performance score for this zone was <strong>${performanceScore}/100</strong>.</p>`
                : '';
            const inner = `
                <h2>Your zone slot has been reassigned</h2>
                <p><strong>${businessName}</strong> did not outbid the challenger within the 72-hour window, so the slot has gone to the highest bidder.</p>
                <div class="alert-box">
                    <p><strong>What this means:</strong></p>
                    <p>• Your listing is now <strong>frozen</strong> — it is no longer shown to travelers.</p>
                    ${scoreLine}
                    <p>• All your analytics are preserved. Nothing is lost.</p>
                    <p>• You can bid again the next time a slot opens in this zone, using your real performance history.</p>
                </div>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">Bid on a Future Slot</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Your zone slot has been reassigned — ${businessName}`,
                html: this._auctionShell('Slot reassigned', 'Your listing has been frozen', inner),
                text: `${businessName} did not outbid the challenger within 72 hours, so the slot went to the highest bidder. Your listing is now frozen, but all analytics are preserved and you can bid again on a future opening.`
            });
            logger.info(`Auction forfeit-notice email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction forfeit-notice email:', error);
            throw error;
        }
    }

    // 5. A bidder won a slot (via forfeit or clean vacancy).
    async sendAuctionWonNotice(email, businessName, winningPrice, lockUntil) {
        if (!email) return { success: false, skipped: true };
        try {
            const inner = `
                <h2>You won the slot! 🎉</h2>
                <p>Congratulations — <strong>${businessName}</strong> has won a Signature slot in your zone's auction.</p>
                <div class="info-box">
                    <p><strong>Your monthly price:</strong></p>
                    <div class="bid">$${winningPrice}/mo</div>
                    <p>This price is locked until <strong>${this._fmtDate(lockUntil)}</strong>. Your listing is now live and visible to travelers.</p>
                </div>
                <p>Log in to your dashboard to review your listing and track its performance.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">Go to Dashboard</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `🎉 You won your zone slot — ${businessName}`,
                html: this._auctionShell("You won the auction! 🎉", 'Your listing is now live', inner),
                text: `Congratulations! ${businessName} won a Signature slot at $${winningPrice}/mo, locked until ${this._fmtDate(lockUntil)}. Your listing is now live on Jinni.`
            });
            logger.info(`Auction won-notice email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction won-notice email:', error);
            throw error;
        }
    }

    // 6. A sitting Signature cancelled — the front-runner gets a clean slot.
    async sendAuctionCleanVacancyNotice(email, businessName, zoneKey, vacancyDate) {
        if (!email) return { success: false, skipped: true };
        try {
            const inner = `
                <h2>A slot is opening in your zone</h2>
                <p>Good news for <strong>${businessName}</strong> — a current Signature listing in your target zone has cancelled, and you are the highest bidder.</p>
                <div class="info-box">
                    <p><strong>What happens next:</strong></p>
                    <p>• The slot frees up on <strong>${this._fmtDate(vacancyDate)}</strong>.</p>
                    <p>• Because this is a voluntary opening, <strong>there is no auction battle</strong> — the slot is yours at your bid price.</p>
                    <p>• Your listing will go live automatically on that date. No action needed.</p>
                </div>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth" class="cta">View My Listing</a>
            `;
            const result = await this.transporter.sendMail({
                from: `"Jinni Business" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `A slot is opening in your zone — ${businessName}`,
                html: this._auctionShell('A slot is opening', "You're first in line — it's yours", inner),
                text: `Good news — a Signature listing in your target zone cancelled and you are the highest bidder. The slot frees on ${this._fmtDate(vacancyDate)} and is yours at your bid price, with no auction battle. Your listing goes live automatically.`
            });
            logger.info(`Auction clean-vacancy email sent to ${email}`);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            logger.error('Failed to send auction clean-vacancy email:', error);
            throw error;
        }
    }

    async testConnection() {
        try {
            await this.transporter.verify();
            logger.info('✅ Gmail service connected successfully');
            return true;
        } catch (error) {
            logger.error('❌ Gmail service connection failed:', error);
            return false;
        }
    }
}
module.exports = new EmailService();
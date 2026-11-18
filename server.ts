import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  getAvailableCloudProviders,
  runAcademicEditingPipeline,
} from './server/academicEngine.ts';
import {
  consumeUserWordQuota,
  createLicenseKeyRecord,
  extractAuthUser,
  loginUserAccount,
  redeemLicenseForUser,
  registerUserAccount,
  requireAdmin,
  requireAuth,
  updateUserByAdmin,
  type AuthenticatedRequest,
} from './server/auth.ts';
import { generateArabicDocxBuffer } from './server/docxExporter.ts';
import { extractTextFromUploadedFile } from './server/fileExtractor.ts';
import {
  appendHistory,
  countUsers,
  deleteProject,
  findLicenseByCode,
  getPlatformConfig,
  listAllUsers,
  listHistory,
  listLicenses,
  listProjects,
  saveDeveloperContact,
  saveFreeTrialConfig,
  saveLicense,
  saveProject,
  saveSubscriptionPlans,
  toPublicUser,
} from './server/storage.ts';
import { computeTextStats, countWords, detectChapters } from './server/textUtils.ts';
import {
  isFreeTrialActive,
  type DeveloperContactInfo,
  type DocxColorTheme,
  type HistoryLogEntry,
  type ParagraphPair,
  type ProcessingSettings,
  type ResearchProject,
  type SubscriptionPlanDefinition,
  type SubscriptionPlanId,
  type SubscriptionStatus,
} from './src/types/academic.ts';

const PORT = Number(process.env.PORT) || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function startServer() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: real client IP for rate limiting
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '15mb' }));

  // Simple in-memory rate limiter (no extra dependency).
  const hits = new Map<string, { n: number; reset: number }>();
  const rateLimit =
    (name: string, max: number, windowMs: number) =>
    (req: Request, res: Response, next: NextFunction) => {
      const key = `${name}:${req.ip}`;
      const now = Date.now();
      const cur = hits.get(key);
      if (!cur || cur.reset < now) {
        hits.set(key, { n: 1, reset: now + windowMs });
        return next();
      }
      cur.n += 1;
      if (cur.n > max) {
        res.status(429).json({ error: 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.' });
        return;
      }
      next();
    };
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 10 * 60 * 1000).unref();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/engine-status', async (_req, res) => {
    const usersCount = await countUsers();
    const providers = getAvailableCloudProviders();
    res.json({
      cloudAvailable: providers.length > 0,
      providers,
      localEngineReady: true,
      hasUsers: usersCount > 0,
    });
  });

  app.get('/api/platform-config', async (_req, res) => {
    try {
      const config = await getPlatformConfig();
      res.json(config);
    } catch {
      res.status(500).json({ error: 'تعذر تحميل إعدادات الباقات والتواصل.' });
    }
  });

  // --- Authentication Routes ---
  app.post('/api/auth/register', rateLimit('register', 10, 60 * 60 * 1000), async (req, res) => {
    try {
      const { email, password, fullName, institution } = req.body as {
        email?: string;
        password?: string;
        fullName?: string;
        institution?: string;
      };
      const result = await registerUserAccount({
        email: email ?? '',
        password: password ?? '',
        fullName: fullName ?? '',
        institution,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر إنشاء الحساب.',
      });
    }
  });

  app.post('/api/auth/login', rateLimit('login', 10, 15 * 60 * 1000), async (req, res) => {
    try {
      const { email, password } = req.body as {
        email?: string;
        password?: string;
      };
      const result = await loginUserAccount({
        email: email ?? '',
        password: password ?? '',
      });
      res.json(result);
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'بيانات الدخول غير صحيحة.',
      });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    const user = await extractAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'الجلسة غير صالحة أو منتهية.' });
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  // --- Paid Subscription & License Redemption ---
  app.post('/api/billing/redeem', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { code } = req.body as { code?: string };
      const result = await redeemLicenseForUser(req.authUser!, code ?? '');
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر تفعيل كود الاشتراك.',
      });
    }
  });

  app.post('/api/billing/consume', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { wordCount } = req.body as { wordCount?: number };
      const updatedUser = await consumeUserWordQuota(
        req.authUser!,
        Math.max(0, Number(wordCount) || 0)
      );
      res.json({ user: updatedUser });
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'الرصيد غير كافٍ.',
      });
    }
  });

  // --- Admin License & User Management ---
  app.get('/api/admin/overview', requireAdmin, async (_req, res) => {
    try {
      const [users, licenses] = await Promise.all([listAllUsers(), listLicenses()]);
      res.json({ users, licenses });
    } catch {
      res.status(500).json({ error: 'تعذر تحميل بيانات الإدارة.' });
    }
  });

  app.post('/api/admin/licenses', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { planId, wordQuota, durationDays, maxUses, note } = req.body as {
        planId?: Exclude<SubscriptionPlanId, 'none'>;
        wordQuota?: number;
        durationDays?: number;
        maxUses?: number;
        note?: string;
      };
      const license = await createLicenseKeyRecord({
        adminEmail: req.authUser!.email,
        planId: planId ?? 'pro_monthly',
        wordQuota,
        durationDays,
        maxUses,
        note,
      });
      res.json({ license });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر إنشاء كود التفعيل.',
      });
    }
  });

  app.patch('/api/admin/licenses/:code', requireAdmin, async (req, res) => {
    try {
      const existing = await findLicenseByCode(req.params.code);
      if (!existing) {
        res.status(404).json({ error: 'كود التفعيل غير موجود.' });
        return;
      }
      const { isRevoked } = req.body as { isRevoked?: boolean };
      const updated = await saveLicense({
        ...existing,
        isRevoked: Boolean(isRevoked),
      });
      res.json({ license: updated });
    } catch {
      res.status(500).json({ error: 'تعذر تحديث حالة الكود.' });
    }
  });

  app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const { planId, subscriptionStatus, addWords, extendDays } = req.body as {
        planId?: SubscriptionPlanId;
        subscriptionStatus?: SubscriptionStatus;
        addWords?: number;
        extendDays?: number;
      };
      const updated = await updateUserByAdmin({
        targetUserId: req.params.id,
        planId,
        subscriptionStatus,
        addWords,
        extendDays,
      });
      res.json({ user: updated });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر تحديث اشتراك الباحث.',
      });
    }
  });

  app.put('/api/admin/plans', requireAdmin, async (req, res) => {
    try {
      const { plans } = req.body as { plans?: SubscriptionPlanDefinition[] };
      if (!Array.isArray(plans) || plans.length === 0) {
        res.status(400).json({ error: 'قائمة الباقات غير صالحة.' });
        return;
      }
      const sanitized: SubscriptionPlanDefinition[] = plans.map((p) => {
        const priceIqd = Math.max(0, Math.round(Number(p.priceIqd) || 0));
        const durationDays = Math.max(1, Math.round(Number(p.durationDays) || 30));
        const wordQuota = Math.max(1000, Math.round(Number(p.wordQuota) || 10000));
        const billingCycle = (p.billingCycle || `${durationDays} يوماً`).trim();
        const priceLabel = `${priceIqd.toLocaleString('en-US')} د.ع / ${billingCycle}`;
        return {
          id: p.id,
          name: (p.name || '').trim() || 'باقة اشتراك',
          badge: (p.badge || '').trim() || 'Pro',
          priceIqd,
          priceLabel,
          billingCycle,
          durationDays,
          wordQuota,
          description: (p.description || '').trim(),
          features: Array.isArray(p.features)
            ? p.features.map((f) => String(f).trim()).filter(Boolean)
            : [],
          highlighted: Boolean(p.highlighted),
        };
      });
      const saved = await saveSubscriptionPlans(sanitized);
      res.json({ plans: saved });
    } catch {
      res.status(500).json({ error: 'تعذر حفظ تعديلات الباقات.' });
    }
  });

  app.put('/api/admin/contact', requireAdmin, async (req, res) => {
    try {
      const { contactInfo } = req.body as { contactInfo?: DeveloperContactInfo };
      if (!contactInfo || typeof contactInfo !== 'object') {
        res.status(400).json({ error: 'بيانات التواصل غير صالحة.' });
        return;
      }
      const saved = await saveDeveloperContact(contactInfo);
      res.json({ contactInfo: saved });
    } catch {
      res.status(500).json({ error: 'تعذر حفظ معلومات التواصل.' });
    }
  });

  app.put('/api/admin/free-trial', requireAdmin, async (req, res) => {
    try {
      const { enabled, durationDays, promoWordQuota } = req.body as {
        enabled?: boolean;
        durationDays?: number;
        promoWordQuota?: number;
      };
      const saved = await saveFreeTrialConfig({
        enabled: Boolean(enabled),
        durationDays,
        promoWordQuota,
      });
      res.json({ freeTrial: saved });
    } catch {
      res.status(500).json({ error: 'تعذر تحديث إعدادات الأسبوع المجاني.' });
    }
  });

  // --- Research Processing & File Endpoints ---
  app.post('/api/detect-chapters', rateLimit('detect', 60, 10 * 60 * 1000), (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const chapters = detectChapters(text);
      const stats = computeTextStats(text);
      res.json({ chapters, stats });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر تحليل بنية النص.',
      });
    }
  });

  app.post('/api/extract-file', rateLimit('extract', 30, 10 * 60 * 1000), (req, res) => {
    upload.single('file')(req, res, async (uploadErr) => {
      if (uploadErr) {
        const msg =
          uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE'
            ? 'حجم الملف يتجاوز الحد المسموح به (25 ميجابايت).'
            : 'حدث خطأ أثناء رفع الملف. يرجى المحاولة مرة أخرى.';
        res.status(400).json({ error: msg });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'لم يتم إرفاق أي ملف.' });
        return;
      }

      try {
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const safeName = /[\u0600-\u06FF]/.test(decodedName) ? decodedName : file.originalname;
        const result = await extractTextFromUploadedFile(file.buffer, safeName);
        const chapters = detectChapters(result.text);
        res.json({ ...result, chapters });
      } catch (err) {
        res.status(422).json({
          error:
            err instanceof Error
              ? err.message
              : 'تعذر استخراج النص من الملف المرفق.',
        });
      }
    });
  });

  app.post('/api/process-research', requireAuth, async (req: AuthenticatedRequest, res) => {
    const { text, settings } = req.body as {
      text?: string;
      settings?: ProcessingSettings;
    };

    if (!text || !text.trim()) {
      res.status(400).json({ error: 'يرجى لصق نص البحث أو رفع ملف قبل بدء التحرير.' });
      return;
    }

    if (!settings) {
      res.status(400).json({ error: 'إعدادات المعالجة غير مكتملة.' });
      return;
    }

    const providers = getAvailableCloudProviders();
    if (providers.length === 0) {
      res.status(400).json({
        error:
          'لا يوجد مفتاح API سحابي مهيأ على الخادم. المنصة تعمل بالمحرك المحلي المطور تلقائياً دون الحاجة لأي API.',
      });
      return;
    }

    const user = req.authUser!;
    const wordsToProcess = countWords(text);
    if (user.role !== 'admin') {
      if (user.subscriptionStatus === 'suspended') {
        res.status(403).json({
          error: 'تم تعليق هذا الحساب مؤقتاً. يرجى مراجعة إدارة المنصة.',
        });
        return;
      }

      const paidRemaining =
        user.subscriptionStatus === 'active'
          ? Math.max(0, user.wordQuotaTotal - user.wordsUsed)
          : 0;
      const hasPaidQuota =
        user.subscriptionStatus === 'active' && paidRemaining >= wordsToProcess;

      if (!hasPaidQuota) {
        const platform = await getPlatformConfig();
        if (isFreeTrialActive(platform.freeTrial)) {
          const trialUsed = user.trialWordsUsed ?? 0;
          const trialRemaining = Math.max(
            0,
            platform.freeTrial.promoWordQuota - trialUsed
          );
          if (trialRemaining < wordsToProcess) {
            res.status(403).json({
              error: `الرصيد التجريبي المجاني المتاح (${trialRemaining.toLocaleString('en-US')}) لا يكفي لمعالجة (${wordsToProcess.toLocaleString('en-US')}) كلمة.`,
            });
            return;
          }
        } else if (user.subscriptionStatus !== 'active') {
          res.status(403).json({
            error: 'يتطلب التحرير الأكاديمي اشتراكاً مدفوعاً مفعّلاً.',
          });
          return;
        } else {
          res.status(403).json({
            error: `رصيد الكلمات المتبقي (${paidRemaining.toLocaleString('en-US')}) لا يكفي لمعالجة (${wordsToProcess.toLocaleString('en-US')}) كلمة.`,
          });
          return;
        }
      }
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (payload: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      await runAcademicEditingPipeline(text, settings, (event) => {
        sendEvent(event);
      });
      await consumeUserWordQuota(user, wordsToProcess);
    } catch (err) {
      sendEvent({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'تعذر إتمام عملية التحرير الأكاديمي.',
      });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.post('/api/export-docx', rateLimit('export', 30, 10 * 60 * 1000), async (req, res) => {
    try {
      const { title, editedText, paragraphs, settings, theme } = req.body as {
        title?: string;
        editedText?: string;
        paragraphs?: ParagraphPair[];
        settings?: ProcessingSettings;
        theme?: DocxColorTheme;
      };

      if (!editedText || !editedText.trim()) {
        res.status(400).json({ error: 'لا يوجد نص محرر لتصديره.' });
        return;
      }

      const buffer = await generateArabicDocxBuffer({
        title: title || 'بحث_أكاديمي_محرر',
        editedText,
        paragraphs,
        settings,
        theme,
      });

      const safeFilename = encodeURIComponent((title || 'academic-research').trim()) + '.docx';
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'تعذر إنشاء ملف Word.',
      });
    }
  });

  // --- Per-User Scoped Projects & History ---
  app.get('/api/projects', async (req, res) => {
    try {
      const user = await extractAuthUser(req);
      if (!user) {
        res.json({ projects: [] });
        return;
      }
      const projects = await listProjects(user.role === 'admin' ? undefined : user.id);
      res.json({ projects });
    } catch {
      res.status(500).json({ error: 'تعذر تحميل المشاريع المحفوظة.' });
    }
  });

  app.post('/api/projects', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const project = req.body as ResearchProject;
      if (!project || !project.id || !project.title) {
        res.status(400).json({ error: 'بيانات المشروع غير صالحة.' });
        return;
      }
      const saved = await saveProject({
        ...project,
        ownerId: project.ownerId || req.authUser!.id,
      });
      res.json({ project: saved });
    } catch {
      res.status(500).json({ error: 'تعذر حفظ المشروع.' });
    }
  });

  app.delete('/api/projects/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      await deleteProject(
        req.params.id,
        req.authUser!.role === 'admin' ? undefined : req.authUser!.id
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'تعذر حذف المشروع.' });
    }
  });

  app.get('/api/history', async (req, res) => {
    try {
      const user = await extractAuthUser(req);
      if (!user) {
        res.json({ history: [] });
        return;
      }
      const history = await listHistory(user.role === 'admin' ? undefined : user.id);
      res.json({ history });
    } catch {
      res.status(500).json({ error: 'تعذر تحميل سجل المعالجة.' });
    }
  });

  app.post('/api/history', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const entry = req.body as HistoryLogEntry;
      if (!entry || !entry.id) {
        res.status(400).json({ error: 'بيانات السجل غير صالحة.' });
        return;
      }
      await appendHistory({
        ...entry,
        ownerId: entry.ownerId || req.authUser!.id,
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'تعذر تحديث سجل المعالجة.' });
    }
  });

  // Always return JSON for unknown /api/* routes (never HTML)
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'نقطة الاتصال المطلوبة غير متوفرة على الخادم.' });
  });

  // Global JSON error middleware
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/')) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'حدث خطأ داخلي في الخادم.',
      });
      return;
    }
    next(err);
  });

  let serveStatic = process.env.NODE_ENV === 'production';
  if (!serveStatic) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch {
      serveStatic = true;
    }
  }
  if (serveStatic) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Academic Editor server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

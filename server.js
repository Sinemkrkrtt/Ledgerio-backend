const express = require('express');
const cors = require('cors');
const Tesseract = require('tesseract.js');
const multer = require('multer');
const fs = require('fs');

// 🌟 YENİ EKLENEN KÜTÜPHANELER
const cron = require('node-cron');
const admin = require('firebase-admin');

// 🔴 GÜVENLİK UYARISI: firebase-key.json dosyasının backend klasöründe olduğundan emin ol.
// GitHub'a yüklememek için .gitignore dosyanın içine mutlaka firebase-key.json yaz!
const serviceAccount = require('./firebase-key.json');

// Firebase Admin'i Başlat
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Sağlık kontrolü
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ledgerio Backend' });
});

// ============================================================================
// ⏰ CRON JOB — HER GECE 00:01'DE ÇALIŞAN OTOMATİK SABİT GİDER BOTU
// ============================================================================
cron.schedule('1 0 * * *', async () => {
    console.log("🤖 [CRON] Sabit gider taraması başladı...");
    
    const now = new Date();
    const today = now.getDate();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    try {
        const snapshot = await db.collection('recurring_expenses').get();
        let processed = 0;

        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            const paymentDay = parseInt(data.payment_day) || 1;
            const amount = parseFloat(data.amount) || 0;
            const userId = data.userId;

            if (amount <= 0 || !userId) continue;

            const effectiveDay = Math.min(paymentDay, lastDayOfMonth);

            // Zaten bu ay ödendiyse veya vadesi gelmediyse atla
            if (data.last_paid_month === currentMonthKey) continue;
            if (today < effectiveDay) continue;

            // 1. İşlem geçmişine (transactions) ekle
            await db.collection('transactions').add({
                userId,
                name: data.name || 'Sabit Gider',
                category: data.category || 'Diğer',
                amount,
                type: 'gider',
                date: admin.firestore.FieldValue.serverTimestamp(),
                notes: 'Otomatik Sabit Ödeme',
                isRecurring: true,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // 2. Kullanıcı bakiyesinden düş (Transaction kullanarak güvenli güncelleme)
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                if (userDoc.exists) {
                    const currentBalance = userDoc.data().totalBalance || 0;
                    transaction.update(userRef, { totalBalance: currentBalance - amount });
                } else {
                    transaction.set(userRef, { totalBalance: -amount }, { merge: true });
                }
            });

            // 3. Tekrarlayan gideri "Bu ay ödendi" olarak işaretle
            await db.collection('recurring_expenses').doc(docSnap.id).update({
                last_paid_month: currentMonthKey,
                last_paid_at: admin.firestore.FieldValue.serverTimestamp(),
            });

            processed++;
        }
        console.log(`✅ [CRON] Tarama bitti. ${processed} adet sabit gider başarıyla işlendi.`);
        
    } catch (error) {
        console.error("❌ [CRON] Çalışma Hatası:", error);
    }
});


// ============================================================================
// 📸 OCR — FİŞ TARAMA ENDPOINT'İ (ORİJİNAL KOD - HİÇ DOKUNULMADI)
// ============================================================================
app.post('/api/ocr/scan', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Resim yüklenemedi" });

        console.log("--- OCR ANALİZ BAŞLADI ---");
        const startTime = Date.now();

        const { data: { text } } = await Tesseract.recognize(req.file.path, 'tur+eng', {
            logger: () => {}
        });

        const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const lines = rawLines.map(l => l.toUpperCase());
        console.log(`📄 ${lines.length} satır OCR'lendi (${Date.now() - startTime}ms)`);

        const priorityKeywords = [
            "ÖDENECEK TUTAR", "ÖDENECEK", "GENEL TOPLAM", "TOPLAM TUTAR",
            "GRAND TOTAL", "AMOUNT DUE", "TOTAL DUE", "ÖDEME TUTARI",
            "TUTAR (TL)", "TUTAR TL", "PAYABLE", "ÖDEME"
        ];
        const secondaryKeywords = [
            "TOPLAM", "TUTAR", "TOPLAN", "TOTAL", "AMOUNT",
            "BORÇ", "ÖDENEN", "PAID", "NET FİYAT", "NAKİT", "KART"
        ];
        const excludeKeywords = [
            "ARA TOPLAM", "ARATOPLAM", "ARA ", "KDV", "HİZMET", "HIZMET",
            "SUBTOTAL", "VAT", "TAX", "İADE", "INDIRIM", "İNDİRİM",
            "PARA ÜSTÜ", "PARA USTU", "CHANGE"
        ];

        const numberRegex = /([0-9]+(?:[.,\s][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/g;

        const parseAmount = (str) => {
            if (!str) return 0;
            let clean = String(str).replace(/\s/g, '');
            const lastDot = clean.lastIndexOf('.');
            const lastComma = clean.lastIndexOf(',');

            if (lastDot > -1 && lastComma > -1) {
                if (lastComma > lastDot) {
                    clean = clean.replace(/\./g, '').replace(',', '.');
                } else {
                    clean = clean.replace(/,/g, '');
                }
            } else if (lastComma > -1) {
                const parts = clean.split(',');
                if (parts.length === 2 && parts[1].length === 2) {
                    clean = parts[0].replace(/\./g, '') + '.' + parts[1];
                } else {
                    clean = clean.replace(/,/g, '');
                }
            } else if (lastDot > -1) {
                const parts = clean.split('.');
                if (parts.length > 1 && parts.slice(1).every(p => p.length === 3)) {
                    clean = clean.replace(/\./g, '');
                }
            }
            const num = parseFloat(clean);
            return isNaN(num) ? 0 : num;
        };

        const containsExcluded = (line) =>
            excludeKeywords.some(ex => line.includes(ex));

        const extractMaxFromLine = (line) => {
            const matches = line.match(numberRegex);
            if (!matches) return null;
            const amounts = matches.map(parseAmount).filter(a => a > 0 && a < 1000000);
            return amounts.length ? Math.max(...amounts) : null;
        };

        const searchKeywords = (keywords) => {
            for (let keyword of keywords) {
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (!line.includes(keyword)) continue;

                    const stripped = line.replace(keyword, '').trim();
                    if (containsExcluded(stripped)) continue;

                    let amt = extractMaxFromLine(line);
                    if (amt) {
                        console.log(`✓ "${keyword}" → ₺${amt} (satır: "${rawLines[i]}")`);
                        return amt;
                    }
                    if (i + 1 < lines.length && !containsExcluded(lines[i + 1])) {
                        amt = extractMaxFromLine(lines[i + 1]);
                        if (amt) {
                            console.log(`✓ "${keyword}" → ₺${amt} (alt satır: "${rawLines[i + 1]}")`);
                            return amt;
                        }
                    }
                }
            }
            return null;
        };

        let finalAmount = null;
        let confidence = 'none';

        finalAmount = searchKeywords(priorityKeywords);
        if (finalAmount) confidence = 'high';

        if (!finalAmount) {
            finalAmount = searchKeywords(secondaryKeywords);
            if (finalAmount) confidence = 'medium';
        }

        if (!finalAmount) {
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (containsExcluded(line)) continue;
                if (/(₺|\bTL\b|\bTRY\b)/.test(line)) {
                    const amt = extractMaxFromLine(line);
                    if (amt && amt > 1) {
                        finalAmount = amt;
                        confidence = 'low';
                        console.log(`✓ Para sembolü ile → ₺${amt} (satır: "${rawLines[i]}")`);
                        break;
                    }
                }
            }
        }

        if (!finalAmount) {
            const candidates = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (containsExcluded(line)) continue;
                const matches = line.match(numberRegex);
                if (!matches) continue;
                matches.forEach(m => {
                    if (/[.,]\d{2}\b/.test(m)) {
                        const amount = parseAmount(m);
                        if (amount > 1 && amount < 1000000) {
                            candidates.push({ amount, lineIdx: i });
                        }
                    }
                });
            }
            if (candidates.length > 0) {
                candidates.sort((a, b) => b.amount - a.amount);
                finalAmount = candidates[0].amount;
                confidence = 'guess';
                console.log(`⚠️ Tahmin: en yüksek tutar → ₺${finalAmount}`);
            }
        }

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        console.log(`📊 Sonuç: ${finalAmount ? '₺' + finalAmount : 'okunamadı'} (güven: ${confidence}) [${Date.now() - startTime}ms]`);
        res.json({ amount: finalAmount, confidence });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("OCR Hatası:", err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ledgerio Sunucusu ${PORT} portunda yayında!`);
});
import express from 'express';
import multer from 'multer';
import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

const ai = new GoogleGenAI({});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const lightingStandards = {
    "Recessed Spotlight": "Luminous efficacy must be >= 80 lm/W, CRI must be >= 90.",
    "Street Light": "Luminous efficacy must be >= 120 lm/W, CRI must be >= 70, IP rating must be IP65 or higher.",
    "High Bay": "Luminous efficacy must be >= 130 lm/W, CRI must be >= 80."
};

// Helper function to automatically retry if Google's servers are busy (503 error)
async function generateWithRetry(fn, retries = 3, delay = 3000) {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0 && (error.status === 503 || error.message?.includes('503') || error.message?.includes('high demand'))) {
            console.log(`Server busy (503). Retrying automatically in ${delay / 1000} seconds... (${retries} attempts left)`);
            await new Promise(res => setTimeout(res, delay));
            return generateWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

app.post('/api/verify-lighting', upload.single('pdfFile'), async (req, res) => {
    try {
        const { manufacturer, country } = req.body;
        const filePath = req.file.path;

        // 1. Upload multi-page PDF to Gemini File API
        const uploadedFile = await ai.files.upload({
            file: filePath,
            config: { mimeType: 'application/pdf' }
        });

        const prompt = `
            You are a multi-page lighting compliance verification engine. Read this entire PDF document.
            Identify EVERY individual specification sheet or product section. Look for product reference labels (e.g., TYPE D1.6, TYPE S2, etc.).
            
            For each product found:
            - Identify its product reference label.
            - Determine its product category (e.g., Recessed Spotlight, Street Light, High Bay).
            - Extract its parameters: Wattage, Delivered Lumens, Luminous Efficacy, CCT, CRI, and IP Rating.
            - Evaluate it against standard rules for that category (Recessed Spotlight rules: efficacy >= 80, CRI >= 90; Street Light rules: efficacy >= 120, CRI >= 70, IP >= IP65; High Bay rules: efficacy >= 130, CRI >= 80).
            
            Return your response ONLY as a valid JSON array of objects in this exact format:
            [
              {
                "productReference": "TYPE D1.6",
                "productCategory": "Recessed Spotlight",
                "status": "PASS",
                "reason": "All specifications met.",
                "extractedSpecs": {
                  "wattage": "14W",
                  "lumens": "1007lm",
                  "efficacy": "80lm/W",
                  "cri": ">90"
                }
              }
            ]
        `;

        // 2. Call Gemini with automatic retry logic for 503 errors
        const response = await generateWithRetry(async () => {
            return await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: createUserContent([
                    createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
                    prompt
                ])
            });
        });

        const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        const evaluations = JSON.parse(cleanText);

        // 3. Loop through each evaluated product and insert them into Supabase
        for (const item of evaluations) {
            const { error } = await supabase
                .from('lighting_submissions')
                .insert([
                    {
                        manufacturer_name: manufacturer,
                        country: country,
                        product_type: `${item.productReference} (${item.productCategory})`,
                        file_url: filePath, 
                        status: item.status,
                        evaluation_details: item
                    }
                ]);

            if (error) console.error("Database insert error for item:", error);
        }

        // Clean up temporary local file
        fs.unlinkSync(filePath);

        res.json({ success: true, evaluations });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(3000, () => console.log('Lighting batch verification backend running on port 3000'));
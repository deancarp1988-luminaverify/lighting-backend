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

// Define strict project schedule requirements for each specific product reference tag
const projectScheduleRules = {
    "TYPE D1.6": {
        category: "Recessed Spotlight",
        minLumens: 1000,
        maxLumens: 1400,
        minEfficacy: 80,
        minCri: 90
    },
    "TYPE D2.6": {
        category: "Recessed Spotlight",
        minLumens: 1500,
        maxLumens: 2000,
        minEfficacy: 85,
        minCri: 90
    },
    "TYPE S2": {
        category: "Street Light",
        minLumens: 5000,
        maxLumens: 10000,
        minEfficacy: 120,
        minCri: 70,
        requiredIp: "IP65"
    }
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

        // 2. Instruct AI to focus strictly on extraction and labeling
        const prompt = `
            You are a multi-page lighting document parser. Read this entire PDF document.
            Identify EVERY individual specification sheet or product section. Look for product reference labels (e.g., TYPE D1.6, TYPE D2.6, TYPE S2).
            
            For each product found, extract these exact parameters into the "extractedSpecs" object:
            - "wattage" (e.g., "14W")
            - "lumens" (e.g., "1200lm")
            - "efficacy" (e.g., "85lm/W")
            - "cct" (e.g., "3000K")
            - "cri" (e.g., "92")
            - "ipRating" (e.g., "IP20")
            - "beamAngle", "inputVoltage", "powerFactor", "dimming", "driver", "dimensions", "lifespan"

            Return your response ONLY as a valid JSON array of objects in this exact format:
            [
              {
                "productReference": "TYPE D1.6",
                "productCategory": "Recessed Spotlight",
                "extractedSpecs": {
                  "wattage": "14W",
                  "lumens": "1200lm",
                  "efficacy": "85lm/W",
                  "cct": "3000K",
                  "cri": "92",
                  "ipRating": "IP20"
                }
              }
            ]
        `;

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
        const extractedProducts = JSON.parse(cleanText);

        const evaluatedResults = [];

        // 3. Programmatically evaluate each product against the Project Schedule Rules
        for (const item of extractedProducts) {
            const refLabel = item.productReference?.trim();
            const rule = projectScheduleRules[refLabel];

            let status = "PASS";
            let reasons = [];

            if (!rule) {
                status = "FAIL";
                reasons.push(`Product reference "${refLabel}" not found in project schedule rules.`);
            } else {
                // Parse numeric values safely from strings (e.g., "1200lm" -> 1200)
                const lumensVal = parseFloat(item.extractedSpecs?.lumens);
                const efficacyVal = parseFloat(item.extractedSpecs?.efficacy);
                const criVal = parseFloat(item.extractedSpecs?.cri);

                // Check Lumen Range
                if (rule.minLumens && lumensVal < rule.minLumens) {
                    status = "FAIL";
                    reasons.push(`Lumens (${lumensVal}lm) is below minimum required (${rule.minLumens}lm).`);
                }
                if (rule.maxLumens && lumensVal > rule.maxLumens) {
                    status = "FAIL";
                    reasons.push(`Lumens (${lumensVal}lm) exceeds maximum allowed (${rule.maxLumens}lm).`);
                }

                // Check Efficacy
                if (rule.minEfficacy && efficacyVal < rule.minEfficacy) {
                    status = "FAIL";
                    reasons.push(`Efficacy (${efficacyVal}lm/W) is below minimum required (${rule.minEfficacy}lm/W).`);
                }

                // Check CRI
                if (rule.minCri && criVal < rule.minCri) {
                    status = "FAIL";
                    reasons.push(`CRI (${criVal}) is below minimum required (${rule.minCri}).`);
                }

                if (reasons.length === 0) {
                    reasons.push("All project schedule specifications successfully met.");
                }
            }

            const evaluationDetails = {
                productReference: refLabel,
                productCategory: item.productCategory,
                status: status,
                reason: reasons.join(" "),
                extractedSpecs: item.extractedSpecs
            };

            evaluatedResults.push(evaluationDetails);

            // 4. Insert individual results into Supabase
            const { error } = await supabase
                .from('lighting_submissions')
                .insert([
                    {
                        manufacturer_name: manufacturer,
                        country: country,
                        product_type: `${refLabel} (${item.productCategory})`,
                        file_url: filePath, 
                        status: status,
                        evaluation_details: evaluationDetails
                    }
                ]);

            if (error) console.error("Database insert error for item:", error);
        }

        // Clean up temporary local file
        fs.unlinkSync(filePath);

        res.json({ success: true, evaluations: evaluatedResults });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(3000, () => console.log('Lighting project verification server running on port 3000'));
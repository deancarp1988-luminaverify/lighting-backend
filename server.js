import express from 'express';
import multer from 'multer';
import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

// Initialize Gemini and Supabase clients
const ai = new GoogleGenAI({});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.post('/api/verify-lighting', upload.single('pdfFile'), async (req, res) => {
    try {
        const { manufacturer, country, productType } = req.body;
        const filePath = req.file.path;

        // 1. Upload PDF to Gemini File API
        const uploadedFile = await ai.files.upload({
            file: filePath,
            config: { mimeType: 'application/pdf' }
        });

        // 2. Define product-specific rules dynamically
        let standardRules = "Rules: Luminous efficacy must be >= 80 lm/W, CRI must be >= 90.";
        if (productType === "Street Light") {
            standardRules = "Rules: Luminous efficacy must be >= 120 lm/W, CRI must be >= 70, IP rating must be IP65 or higher.";
        }

        // 3. Ask Gemini to extract specifications and cross-check using SDK content helpers
        const prompt = `
            You are a lighting compliance verification engine. Read this PDF data sheet.
            Extract the following parameters: Wattage, Delivered Lumens, Luminous Efficacy, CCT, CRI, and IP Rating.
            Evaluate them strictly against these standards: ${standardRules}
            
            Return your response ONLY as a valid JSON object in this exact format:
            {
              "status": "PASS" or "FAIL",
              "reason": "Clear explanation of why it passed or failed any requirements",
              "extractedSpecs": {
                "wattage": "...",
                "lumens": "...",
                "efficacy": "...",
                "cri": "...",
                "ipRating": "..."
              }
            }
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: createUserContent([
                createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
                prompt
            ])
        });

        // Clean and parse the AI response text into JSON
        const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        const evaluation = JSON.parse(cleanText);

        // 4. Save submission and results to your Supabase catalog
        const { error } = await supabase
            .from('lighting_submissions')
            .insert([
                {
                    manufacturer_name: manufacturer,
                    country: country,
                    product_type: productType,
                    file_url: filePath, 
                    status: evaluation.status,
                    evaluation_details: evaluation
                }
            ]);

        if (error) throw error;

        // Clean up temporary local file
        fs.unlinkSync(filePath);

        // 5. Send result back to the frontend website
        res.json({ success: true, evaluation });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(3000, () => console.log('Lighting verification backend running on port 3000'));
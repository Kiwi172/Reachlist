import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes.js';
import campaignRoutes from './routes/campaigns.routes.js';
import publicRoutes from './routes/public.routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());

// SNS posts JSON with a text/plain content-type, so that body has to be
// captured as raw text before the JSON parser sees it.
app.use('/webhooks/ses', express.text({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '1mb' }));

app.use('/auth', authRoutes);
app.use('/api', campaignRoutes);
app.use('/', publicRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = Number(process.env.PORT || 4001);
app.listen(PORT, () => {
  console.log(`Outreach API on :${PORT} (send provider: ${process.env.SEND_PROVIDER || 'console'})`);
});

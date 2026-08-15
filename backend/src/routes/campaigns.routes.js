import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as c from '../controllers/campaigns.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/products', c.listProducts);
router.post('/products', c.createProduct);

router.get('/campaigns', c.listCampaigns);
router.post('/campaigns', c.createCampaign);
router.get('/campaigns/:id', c.getCampaign);
router.patch('/campaigns/:id/criteria', c.updateCriteria);
router.post('/campaigns/:id/discover', c.startDiscovery);
router.get('/campaigns/:id/prospects', c.listProspects);
router.post('/campaigns/:id/drafts', c.generateDrafts);
router.post('/campaigns/:id/send', c.sendApproved);
router.post('/campaigns/:id/resume', c.resumeCampaign);

router.patch('/drafts/:draftId', c.updateDraft);
router.post('/prospects/:prospectId/review', c.reviewProspect);

export default router;

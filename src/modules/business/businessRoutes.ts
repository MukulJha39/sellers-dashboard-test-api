import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { uploadImage } from '../../middleware/upload';
import { asyncHandler, validate } from '../../middleware/validate';
import { businessUpdateRules } from '../catalog/catalogValidators';
import { rejectPhoneMutation } from '../merchant/merchantValidators';
import {
  deleteBusinessLogo,
  getBusiness,
  patchBusiness,
  putBusinessLogo,
} from './businessController';

export const businessRouter = Router();

businessRouter.use(authenticateMerchant);

// Read creates an empty profile on first use, so setup can start from any one field.
businessRouter.get('/', asyncHandler(getBusiness));

// The business contact number is its own editable field. rejectPhoneMutation guards the
// merchant's verified sign-in number, which is never editable and is not part of this
// payload (PRD section 4).
businessRouter.patch('/', rejectPhoneMutation, ...validate(businessUpdateRules), asyncHandler(patchBusiness));

businessRouter.put('/logo', uploadImage.single('logo'), asyncHandler(putBusinessLogo));
businessRouter.delete('/logo', asyncHandler(deleteBusinessLogo));

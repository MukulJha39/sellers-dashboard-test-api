import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { uploadImage } from '../../middleware/upload';
import { asyncHandler, validate } from '../../middleware/validate';
import { deleteMyPhoto, getMe, patchMe, putMyPhoto } from './merchantController';
import { profileUpdateRules, rejectPhoneMutation } from './merchantValidators';

export const merchantRouter = Router();

merchantRouter.use(authenticateMerchant);

merchantRouter.get('/me', asyncHandler(getMe));

merchantRouter.patch('/me', rejectPhoneMutation, ...validate(profileUpdateRules), asyncHandler(patchMe));

merchantRouter.put('/me/photo', uploadImage.single('photo'), asyncHandler(putMyPhoto));

merchantRouter.delete('/me/photo', asyncHandler(deleteMyPhoto));

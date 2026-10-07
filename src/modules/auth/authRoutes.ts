import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { otpRequestLimiter, otpVerifyLimiter, refreshLimiter } from '../../middleware/rateLimit';
import { uploadImage } from '../../middleware/upload';
import { asyncHandler, validate } from '../../middleware/validate';
import { postLogout, postOtpRequest, postOtpVerify, postRefresh, postRegister } from './authController';
import { otpRequestRules, otpVerifyRules, refreshRules, registerRules } from './authValidators';

export const authRouter = Router();

// 1. Phone number + country code -> one-time code
authRouter.post('/otp/request', otpRequestLimiter, ...validate(otpRequestRules), asyncHandler(postOtpRequest));

// 2 & 3. Verify the code, then either sign in or continue to registration
authRouter.post('/otp/verify', otpVerifyLimiter, ...validate(otpVerifyRules), asyncHandler(postOtpVerify));

// 4. Registration for a newly verified phone number (optional profile photo)
authRouter.post(
  '/register',
  uploadImage.single('photo'),
  ...validate(registerRules),
  asyncHandler(postRegister),
);

authRouter.post('/refresh', refreshLimiter, ...validate(refreshRules), asyncHandler(postRefresh));

authRouter.post('/logout', authenticateMerchant, asyncHandler(postLogout));

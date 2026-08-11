-- Admin panel: lets Ghazal add extra phone numbers through the same
-- add/remove list UI already used for Instagram/Telegram/WhatsApp/Baleh,
-- instead of a bolt-on single field. ContactInfo.phone (the one main
-- number shown everywhere) is untouched — this is purely additive, for
-- anything beyond that one number.
ALTER TYPE "SocialPlatform" ADD VALUE 'PHONE';

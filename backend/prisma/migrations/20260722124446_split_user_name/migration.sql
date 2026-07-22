-- Split User.name into required firstName/lastName fields.
-- Existing rows are backfilled by splitting on the first space; rows with
-- no name at all (or blank) get a clear placeholder rather than losing data.

ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

UPDATE "User" SET
  "firstName" = CASE
    WHEN "name" IS NULL OR trim("name") = '' THEN 'کاربر'
    WHEN position(' ' in trim("name")) = 0 THEN trim("name")
    ELSE split_part(trim("name"), ' ', 1)
  END,
  "lastName" = CASE
    WHEN "name" IS NULL OR trim("name") = '' THEN '-'
    WHEN position(' ' in trim("name")) = 0 THEN '-'
    ELSE trim(substring(trim("name") from position(' ' in trim("name")) + 1))
  END;

ALTER TABLE "User" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "lastName" SET NOT NULL;

ALTER TABLE "User" DROP COLUMN "name";

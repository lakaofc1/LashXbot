# LashXbot fixes (සිංහල)

මෙම build එකේ වෙනස්කම්:
- Baileys `ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2` වැනි wrappers ඇතුළේ ඇති text/caption හඳුනාගනී.
- `BAE5` වලින් පටන් ගන්න message ID ඇති පණිවිඩ නොසලකා හැරීම ඉවත් කර ඇත.
- photo/video/document නැවත යවන විට delete info සමඟ මුල් message caption/text එකද caption එකට ඇතුළත් කරයි.
- sticker/voice/contact/location වැනි caption නොමැති media සඳහා resend කළ item එක quoted reply කර delete details යවයි.
- group admin JID normalize කරලා Anti-Link / Anti-Bad admin check එක නිවැරදි කර ඇත.

## Deploy
1. ZIP extract කර GitHub repo එක update කරන්න.
2. Heroku deploy කරන්න.
3. Bot එකට group admin permission දෙන්න.
4. `#setfeature antilink on` සහ `#setfeature antibad on` යොදා පරීක්ෂා කරන්න.

සීමාවන්: මේ build එකේ live WhatsApp/Heroku test කරලා නැහැ. Anti-delete message metadata local filesystem එකට ලියන නිසා Heroku restart/redeploy පසු පැරණි message cache එක නැතිවිය හැක. WhatsApp media key එක expired නම් හෝ media bytes ලබාගත නොහැකි නම්, සෑම attachment එකක්ම recover කිරීම සහතික කළ නොහැක. Durable media recovery සඳහා media bytes සහ message cache එක MongoDB/GridFS හෝ වෙනත් persistent storage එකකට save කළ යුතුය.

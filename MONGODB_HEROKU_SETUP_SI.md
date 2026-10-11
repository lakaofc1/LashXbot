# LashXbot + MongoDB Atlas + Heroku (සිංහල)

## 1. MongoDB Atlas
1. https://www.mongodb.com/atlas වෙත ගොස් account එකක් හදා Free cluster එකක් create කරන්න.
2. Database Access තුළ database user එකක් සහ ශක්තිමත් password එකක් හදන්න.
3. Network Access තුළ `0.0.0.0/0` entry එකක් එක් කරන්න (Heroku outbound IP ස්ථිර නොවන නිසා). ශක්තිමත්, වෙනත් තැනක භාවිතා නොකරන password එකක් භාවිතා කරන්න.
4. Cluster > Connect > Drivers > Node.js වෙතින් `mongodb+srv://...` URI එක ගන්න. `<password>` වෙනුවට database user password එක දාන්න; URI reserved characters URL-encode කරන්න.

## 2. Heroku Config Vars
Heroku app > Settings > Config Vars:
- `MONGODB_URI` = සම්පූර්ණ Atlas connection URI
- `MONGODB_DB_NAME` = `lashxbot`
- `PAIRING_NUMBER` = WhatsApp number එක country code සමඟ, `+` නැතුව (උදා. `9477xxxxxxx`)

URI එක source code/GitHub එකට hardcode කරන්න එපා. `SESSION_ID` අවශ්‍ය නැහැ; මේ build එක MongoDB එකෙන් credentials සහ Signal keys දෙකම save/load කරනවා.

## 3. Deploy සහ pair
1. මේ folder එකේ සියලු files GitHub repo එකට commit/push කර Heroku deploy කරන්න, නැතිනම් Heroku Git deploy ක්‍රමය භාවිතා කරන්න.
2. Heroku Resources තුළ `worker: node index.js` process එක ON කරන්න. Web dyno එකක් පමණක් තිබුණොත් bot එක run නොවෙයි.
3. පළමු වරට logs වල Pairing Code එක පෙනේවි. WhatsApp > Linked devices > Link a device > Link with phone number එකෙන් code එක ඇතුළත් කරන්න.
4. `Connected Successfully` සහ MongoDB errors නැති බව Logs වල බලන්න.
5. ඉන්පසු worker restart කරලා බලන්න. Credentials/key data MongoDB එකේ තිබෙන නිසා සාමාන්‍ය restart එකකදී නැවත pair විය යුතු නැහැ.

## සටහන්
- `MONGODB_URI` වැරදි නම් හෝ Atlas IP access/database user permissions නැත්නම් connection fail වේ.
- WhatsApp විසින් device එක logout කළොත් නැවත pair කිරීමට සිදුවේ.
- එකම MongoDB auth database එක භාවිතා කරන worker replicas කිහිපයක් එකවර run කරන්න එපා; එක worker instance එකක් පමණක් තබන්න.
- `0.0.0.0/0` ඕනෑම IP එකකට connection attempt කිරීමට ඉඩ දෙන නිසා database user password එක ශක්තිමත් විය යුතුයි.

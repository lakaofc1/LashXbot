'use strict';

const { MongoClient } = require('mongodb');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

let clientPromise;
async function getDb() {
  // Default URI is included so you do not need to add MONGODB_URI in Heroku Config Vars.
  // Prefer rotating this database password and setting MONGODB_URI in Heroku Config Vars for security.
  const uri = process.env.MONGODB_URI || 'mongodb+srv://lashofc:lashofc@lashofc.z96hrbf.mongodb.net/?appName=lashofc';
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    clientPromise = client.connect().catch((err) => { clientPromise = null; throw err; });
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB_NAME || 'lashxbot');
}

const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (value) => JSON.parse(value, BufferJSON.reviver);

async function useMongoDBAuthState() {
  const db = await getDb();
  const auth = db.collection('whatsapp_auth');
  const keys = db.collection('whatsapp_keys');
  await auth.createIndex({ _id: 1 });
  await keys.createIndex({ type: 1, id: 1 }, { unique: true });

  const saved = await auth.findOne({ _id: 'creds' });
  const creds = saved?.value ? decode(saved.value) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        if (!ids.length) return result;
        const docs = await keys.find({ type, id: { $in: ids } }).toArray();
        for (const doc of docs) result[doc.id] = decode(doc.value);
        return result;
      },
      set: async (data) => {
        const operations = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            if (value == null) operations.push({ deleteOne: { filter: { type, id } } });
            else operations.push({ updateOne: { filter: { type, id }, update: { $set: { value: encode(value) } }, upsert: true } });
          }
        }
        if (operations.length) await keys.bulkWrite(operations, { ordered: false });
      }
    }
  };

  const saveCreds = async () => {
    await auth.updateOne({ _id: 'creds' }, { $set: { value: encode(state.creds), updatedAt: new Date() } }, { upsert: true });
  };
  return { state, saveCreds };
}

async function loadBotSettings() {
  const db = await getDb();
  const doc = await db.collection('bot_settings').findOne({ _id: 'config' });
  if (!doc) return null;
  delete doc._id;
  return doc;
}

async function saveBotSettings(config) {
  const db = await getDb();
  const fields = ['workMode', 'ANTI_DELETE', 'antiDelete', 'autoRead', 'autoStatusView', 'alwaysOnline', 'autoTyping', 'autoRecording', 'statusEmoji'];
  const settings = {};
  for (const field of fields) if (config[field] !== undefined) settings[field] = config[field];
  await db.collection('bot_settings').updateOne(
    { _id: 'config' },
    { $set: { ...settings, updatedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = { useMongoDBAuthState, loadBotSettings, saveBotSettings };

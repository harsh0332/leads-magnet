# Lead Engine

Google Maps se aise local businesses dhoondta hai jinki digital presence weak
hai — website nahi, listing unclaimed, photos nahi — aur ek scored calling list
bana ke deta hai.

## Ek baar ka setup

```bash
npm install
npx playwright install chromium
```

Phir Antigravity me ye folder kholo aur `prompts/PHASES.md` ka **Phase 1**
chalao. Ye skip mat karna — selectors live verify hone zaroori hain.

## Rozana ka use

Antigravity ke agent chat me:

```
/leads Indore dentist
/leads Bhopal ke interior designers
/leads Pithampur factory owners
```

Bas. Naya sheher ya naya business type ho to agent khud config me add kar lega.

## Manually chalana ho to

```bash
npm run pipeline -- --city=Indore --category=dentist
```

Output `output/<runId>/` me:

| File | Kya hai |
|---|---|
| `REPORT.md` | Call sheet — phone pe padhne layak |
| `tier-a.csv` | Aaj call karne wale |
| `leads.csv` | Poori scored list |
| `raw.csv` | Bina filter ka data |
| `errors.log` | Jo records fail hue |

## Structure

```
AGENTS.md                    ← agent ka main context, auto-load hota hai
.agents/rules/               ← selector aur scoring discipline
.agents/workflows/           ← /leads, /verify-selectors
config/localities.json       ← city → mohalle (120-result cap todne ke liye)
config/categories.json       ← business type → search synonyms
src/selectors.js             ← SAARE selectors sirf yahan
prompts/PHASES.md            ← phase-wise prompts
```

## Time aur cost

- Ek city + ek category = ~100 queries = **5-6 ghante**, raat me chalao
- Cost: **₹0** — koi API nahi, koi subscription nahi
- Output: ~1,500-2,500 raw records → ~350-500 qualified → ~30-50 Tier A

## Do cheezein yaad rakhna

**Selectors tutenge.** Google DOM har kuch mahine me badalta hai. `/verify-selectors`
chalao, 10 minute me theek ho jayega. Sirf `src/selectors.js` edit hoti hai.

**Ye calling list hai, bulk messaging list nahi.** Cold WhatsApp/SMS pe TRAI DND
aur WhatsApp Business policy lagti hai — number ban ho jayega. Call karo, baat
karo, phir opt-in ke baad WhatsApp.

---
name: vinted-listing
description: Turn photos and a few notes dropped in the chat into a finished, copy-ready Vinted listing — item confirmed from the photos, priced from live Vinted comparables — that the seller pastes into the Vinted app and posts themselves. Use whenever the user drops item photos, says "list this", "sell this", "price this", "post this on Vinted", or sends item details for Vinted, even if they don't name the skill.
---

# Vinted listing, phone mode

The seller drops photos and a few words in the chat. You do everything except the final tap: confirm the item, price it, write the listing, and hand it back in fields they can paste into the Vinted app one by one. You never sign in to their account or post for them.

## Setup (once per session)

The pricing commands run from this repo. Build it if `dist/cli.js` is missing:

```bash
cd vinted-mcp-cli && [ -f dist/cli.js ] || (npm install --no-audit --no-fund --silent && npm run build --silent)
```

Pass `VINTED_PROXY_URL=$HTTPS_PROXY` to every command in a cloud session. Default to `--country us` unless the seller says they sell on another Vinted country site.

## Workflow

1. **Look at every photo.** Read the brand tag, size tag, care label (material), and any style code. Note each visible flaw: marks, pilling, fading, holes, missing buttons. Write down which photo shows what.
2. **Ask only what the photos can't show.** That is usually measurements, or a flaw you can't see clearly. If size or brand is unreadable, ask. Don't guess.
3. **Confirm the item.** When a style code or model name is visible, search the web for the exact model and its retail price. Flag anything that doesn't add up, like a label that doesn't match the claimed brand. Never list a suspected counterfeit under the real brand.
4. **Price it from live listings:**
   ```bash
   VINTED_PROXY_URL=$HTTPS_PROXY node dist/cli.js price "<brand> <model> <item type>" --country us --brand "<brand>" --size "<size>" --condition <condition>
   ```
   With fewer than 10 comparables, drop `--size`, then `--condition`, and say the price is rough. Recommend one price: `fair` by default, `quickSale` if the seller wants it gone fast.
5. **Name the category** the way the app's picker shows it, e.g. Men › Clothing › Hoodies & sweatshirts. The category API answers 403 from cloud sessions, so take the path from the item type; the app also suggests a category from the title.
6. **Write the listing** in the format below.

## Condition grades (Vinted's own; never overstate)

- **New with tags**: tags still attached
- **New without tags**: never worn, no tags
- **Very good**: worn a few times, no flaws
- **Good**: worn, with small visible wear that you describe
- **Satisfactory**: clear wear or flaws, all described

If a photo shows a flaw, it goes in the description, and the grade drops to match.

## Output format

Each field the seller pastes goes in its own code block, so one tap copies it:

````
**Photos, in this order:** 1 front · 2 back · 3 brand/size label · 4 detail · 5 flaw

**Title**
```
Nike Tech Fleece full-zip hoodie grey men's L
```
**Description**
```
Nike Tech Fleece full-zip hoodie in dark grey heather, men's size L.
Worn a handful of times. Small mark on the left cuff (photo 5), otherwise no pilling, fading or damage.
Pit to pit 23 in · length 27 in.
Smoke-free home, ships within 2 days. Bundle discounts on my other items.
```
**Category:** Men › Clothing › Hoodies & sweatshirts › Zip-up hoodies
**Brand:** Nike · **Size:** L · **Condition:** Good · **Colour:** Grey
**Parcel size:** Small
**Price**
```
34
```
Priced from 96 similar listings on vinted.com: median $35, middle half $21–45. $34 should sell within a couple of weeks; $21 if you want it gone fast.
````

Rules for the fields:
- **Title**: up to 100 characters. Use the words buyers search for: brand, model, item type, key detail (colour or fit), size. No hype words or emoji.
- **Description**: what it is, the condition with every flaw and its photo number, measurements when you have them, material if the label shows it, then a one-line footer.
- **Parcel size**: small for most clothing; medium for shoes, boots, coats and heavy knits; large for anything bigger than a shoebox.
- End with one line: "Post it in the app, then send the next one."

## Never

- Ask for or accept the seller's Vinted password, or try to sign in or post on their behalf from this session.
- Invent a market price. If the price command fails, say so and give a price range from retail or the web instead, clearly labelled.
- Describe an item as better than the photos show.

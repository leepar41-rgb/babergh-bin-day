"""Refresh the public Babergh collection-day results for one test property."""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://www.babergh.gov.uk/check-your-collection-day"
NS = "_com_placecube_digitalplace_local_waste_portlet_CollectionDayFinderPortlet_"
POSTCODE = "CO10 1AU"
HOUSE = "1"
OUTPUT = Path("collections.json")


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            await page.locator("#" + NS + "postcode").fill(POSTCODE)
            await page.locator("#" + NS + "btnAddressLookup").click()

            select = page.locator("#" + NS + "uprn")
            try:
                await page.wait_for_function(
                    """id => { const el = document.getElementById(id);
                        return !!el && el.options.length > 1; }""",
                    arg=NS + "uprn", timeout=30000
                )
            except Exception:
                print("DIAGNOSTIC: URL", page.url)
                print("DIAGNOSTIC: Select count", await select.count())
                print("DIAGNOSTIC: Options", await select.locator("option").all_text_contents() if await select.count() else "missing")
                print("DIAGNOSTIC: Body", (await page.locator("body").inner_text())[:3500])
                raise RuntimeError("Babergh address dropdown did not populate; see diagnostic output")
            options = await select.locator("option").evaluate_all(
                """els => els.map(o => ({value:o.value, text:o.textContent.trim()}))"""
            )
            match = next(
                (o for o in options if o["value"]
                 and o["text"].upper().startswith("1 VANNERS ROAD")
                 and POSTCODE in o["text"].upper()), None
            )
            if not match:
                raise RuntimeError("1 Vanners Road was not returned in the address list")

            await select.select_option(match["value"])
            await page.locator("#" + NS + "fcd_submit").click()
            table = page.locator("div.collection-days-page table")
            await table.wait_for(state="visible", timeout=45000)
            rows = await table.locator("tr").evaluate_all(
                """trs => trs.flatMap(tr => {
                    const c=[...tr.querySelectorAll('td')].map(td => td.textContent.trim().replace(/\\s+/g,' '));
                    if (c.length < 2 || !c[0]) return [];
                    return [c[1], ...(c.length >= 4 ? [c[3]] : [])]
                      .filter(Boolean).map(date => ({type:c[0], date}));
                })"""
            )
            if not rows:
                raise RuntimeError("Babergh returned no collection dates")
            normalized = []
            for row in rows:
                date = datetime.strptime(row["date"], "%A %d %b %Y").date().isoformat()
                normalized.append({"date": date, "type": row["type"]})
            normalized = list({(r["date"], r["type"]): r for r in normalized}.values())
            normalized.sort(key=lambda r: (r["date"], r["type"]))
            data = {
                "source": "Babergh District Council",
                "address": match["text"],
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "collections": normalized,
            }
            OUTPUT.write_text(json.dumps(data, indent=2) + "\n")
            print("Retrieved", len(normalized), "actual collection entries")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

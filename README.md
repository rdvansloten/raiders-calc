# Raiders Damage Calculator

**Live at: <https://raiders-calc.woomies.ink/>**

Fan-made build damage calculator for [Splatoon Raiders](https://splatoonwiki.org/wiki/Splatoon_Raiders).

Formula reverse-engineered by Laugh_Lover/Delpolo, whose research and
spreadsheet this tool is built on. Credited with their blessing:
[GameFAQs thread](https://gamefaqs.gamespot.com/boards/540184-splatoon-raiders/81174710) | 
[Google Sheets](https://docs.google.com/spreadsheets/d/e/2PACX-1vThDUSq-3xSdnngXijX_8sPtEPU2vnnj26uWvLFn5qZmlwnKbl-KDOnJ_2Z0Ix-pdax6XFCW-sl8NmV/pubhtml).

## Local development

Calculator is written in vanilla HTML and JS. Extraction tools

To rebuild data: `python3 tools/extract.py`

### Docker

Serves the repo root with nginx, the same way GitHub Pages hosts it:

`docker compose up -d --build`

Open <http://localhost:26692>

The Python tools also run containerized (stdlib only, no image build):

```sh
docker compose run --rm tools tools/extract.py
docker compose run --rm tools tools/scrape_gadgets.py
docker compose run --rm tools tools/make_icons.py
```
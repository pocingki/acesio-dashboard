import zlib from 'node:zlib';

// ---------- CSV (BOM agar Excel membaca UTF-8) ----------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = "'" + s; // cegah formula injection
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------- XLSX minimal (tanpa library) ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function sheetXml(headers, rows, rpCols, intCols, hasDrawing) {
  const cell = (v, r, c, header) => {
    const ref = `${colName(c)}${r}`;
    if (!header && typeof v === 'number' && (rpCols.has(c) || intCols.has(c))) return `<c r="${ref}" s="${rpCols.has(c) ? 2 : 3}"><v>${v}</v></c>`;
    const style = header ? ' s="1"' : '';
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(v ?? '')}</t></is></c>`;
  };
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<cols>' + headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 24 : 22}" customWidth="1"/>`).join('') + '</cols><sheetData>';
  xml += '<row r="1">' + headers.map((h, c) => cell(h, 1, c, true)).join('') + '</row>';
  rows.forEach((row, i) => {
    xml += `<row r="${i + 2}">` + row.map((v, c) => cell(v, i + 2, c, false)).join('') + '</row>';
  });
  return xml + '</sheetData>' + (hasDrawing ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
}

function chartXml(sheetName, title, n) {
  const q = `'${sheetName.replace(/'/g, "''")}'`;
  const t = (txt) => `<c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr lang="id-ID" sz="1200" b="1"/><a:t>${esc(txt)}</a:t></a:r></a:p></c:rich></c:tx>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<c:roundedCorners val="0"/><c:chart><c:title>${t(title)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>` +
    '<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${q}!$B$1</c:f></c:strRef></c:tx>` +
    '<c:spPr><a:solidFill><a:srgbClr val="0F3BA8"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>' +
    '<c:dLbls><c:spPr><a:noFill/></c:spPr><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>' +
    `<c:cat><c:strRef><c:f>${q}!$A$2:$A$${n + 1}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${q}!$B$2:$B$${n + 1}</c:f></c:numRef></c:val></c:ser>` +
    '<c:gapWidth val="50"/><c:axId val="111"/><c:axId val="222"/></c:barChart>' +
    '<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
    '<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="t"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9E3F8"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>' +
    '</c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>';
}

function drawingXml(n, col) {
  const cy = Math.max(320, n * 26 + 100) * 9525;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${640 * 9525}" cy="${cy}"/>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Grafik"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;Rp&quot;\\ #,##0"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF0F3BA8"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0x00210000, 10); // tanggal tetap 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(deflated.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const REL = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// sheets: [{ name, headers, rows, rpCols?, intCols?, chart?: { title } }]  — chart: batang dari kolom A (nama) dan B (angka)
export function toXlsx(sheets) {
  const files = [];
  const overrides = [];
  const wbSheets = [];
  const wbRels = [];
  sheets.forEach((sh, i) => {
    const n = i + 1;
    const chartRows = sh.chart ? sh.rows.length : 0;
    const hasChart = !!sh.chart && chartRows > 0;
    files.push([`xl/worksheets/sheet${n}.xml`, sheetXml(sh.headers, sh.rows, new Set(sh.rpCols || []), new Set(sh.intCols || []), hasChart)]);
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbSheets.push(`<sheet name="${esc(sh.name.slice(0, 31))}" sheetId="${n}" r:id="rId${n}"/>`);
    wbRels.push(REL(`rId${n}`, 'worksheet', `worksheets/sheet${n}.xml`));
    if (hasChart) {
      files.push([`xl/worksheets/_rels/sheet${n}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${REL('rId1', 'drawing', `../drawings/drawing${n}.xml`)}</Relationships>`]);
      files.push([`xl/drawings/drawing${n}.xml`, drawingXml(chartRows, sh.headers.length + 1)]);
      files.push([`xl/drawings/_rels/drawing${n}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${REL('rId1', 'chart', `../charts/chart${n}.xml`)}</Relationships>`]);
      files.push([`xl/charts/chart${n}.xml`, chartXml(sh.name.slice(0, 31), sh.chart.title, chartRows)]);
      overrides.push(`<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      overrides.push(`<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    }
  });
  wbRels.push(REL(`rId${sheets.length + 1}`, 'styles', 'styles.xml'));
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${REL('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets.join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`],
    ['xl/styles.xml', STYLES],
    ...files,
  ]);
}

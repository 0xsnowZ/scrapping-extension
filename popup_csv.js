/**
 * popup_csv.js — CSV & Excel export logic for AutoAzubi popup
 * Loaded before popup.js. Exposes: window.downloadCSV(data), window.downloadExcel(data)
 */

// ── Shared Helpers ──────────────────────────────────────────────────────────────

const _exportDecodeEl = document.createElement("textarea");
function _decodeEntities(str) {
  _exportDecodeEl.innerHTML = str;
  return _exportDecodeEl.value;
}

function _splitAddress(raw) {
  const addr = (raw || "").trim();
  const threePartMatch = addr.match(/^(.+?),\s*(\d{5}),\s*(.+)$/);
  if (threePartMatch) {
    return {
      street: threePartMatch[1].trim(),
      plz: threePartMatch[2],
      city: threePartMatch[3].trim(),
    };
  }
  const match = addr.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (match) {
    return { street: match[1].trim(), plz: match[2], city: match[3].trim() };
  }
  const noComma = addr.match(/^(.+?)\s+(\d{5})\s+(.+)$/);
  if (noComma) {
    return {
      street: noComma[1].trim(),
      plz: noComma[2],
      city: noComma[3].trim(),
    };
  }
  const plzOnly = addr.match(/^(\d{5})\s+(.+)$/);
  if (plzOnly) {
    return { street: "", plz: plzOnly[1], city: plzOnly[2].trim() };
  }
  return { street: addr, plz: "", city: "" };
}

function _cleanPhone(raw) {
  return (raw || "")
    .replace(/^Tel\.\s*/i, "")
    .replace(/\s*Gratis anrufen!?\s*$/i, "")
    .trim();
}

function _deduplicateData(data) {
  const seenEmails = new Set();
  const seenCompanyAddr = new Set();
  return data.filter((row) => {
    const company = (row.company || "").trim();
    if (!company) return false;

    const email = (row.email || "").trim().toLowerCase();
    if (email) {
      if (seenEmails.has(email)) return false;
      seenEmails.add(email);
      return true;
    }
    const key = `${company.toLowerCase().replace(/\s+/g, ' ')}|${(row.address || "").trim().toLowerCase().replace(/\s+/g, ' ')}`;
    if (seenCompanyAddr.has(key)) return false;
    seenCompanyAddr.add(key);
    return true;
  });
}

const _exportHeaders = [
  "Company Name",
  "Email",
  "Street",
  "PLZ",
  "City",
  "Contact Person",
  "Website",
  "Telephone",
  "Source Portal",
  "Extracted Date",
];

function _rowToArray(row) {
  const contact = _decodeEntities(row.contact || "");
  const addr = _splitAddress(_decodeEntities(row.address || ""));
  return [
    _decodeEntities(row.company || ""),
    row.email || "",
    addr.street,
    addr.plz,
    addr.city,
    contact,
    row.website || row.link || "",
    _cleanPhone(row.phone),
    row.source || "",
    row.extractedAt || "",
  ];
}



// ── Clipboard & CSV Exports ──────────────────────────────────────────────────────

/**
 * Extract unique, valid email addresses from scraped lead objects.
 * @param {Array<Object>} data - Array of scraped lead objects
 * @returns {Array<string>} Array of unique email addresses
 */
function _extractUniqueEmails(data) {
  const emails = new Set();
  (data || []).forEach((row) => {
    const raw = (row.email || "").trim().toLowerCase();
    if (raw && /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(raw)) {
      emails.add(raw);
    }
  });
  return Array.from(emails);
}

/**
 * Copy all unique scraped emails to the clipboard formatted as comma-separated list.
 * e.g., "email1@corp.de, email2@corp.de"
 * @param {Array<Object>} data - Array of scraped lead objects
 * @returns {Promise<{ success: boolean, count: number, text: string }>}
 */
window.copyEmailsToClipboard = async function copyEmailsToClipboard(data) {
  const uniqueEmails = _extractUniqueEmails(data);
  if (uniqueEmails.length === 0) {
    return { success: false, count: 0, text: "" };
  }

  const formatted = uniqueEmails.join(", ");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(formatted);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = formatted;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    return { success: true, count: uniqueEmails.length, text: formatted };
  } catch (err) {
    console.error("Failed to copy emails to clipboard:", err);
    return { success: false, count: uniqueEmails.length, text: formatted, error: err };
  }
};

/**
 * Download scraped data as a clean UTF-8 CSV file with BOM for Excel compatibility.
 * @param {Array<Object>} data - Array of scraped lead objects
 */
window.downloadCSV = function downloadCSV(data) {
  data = _deduplicateData(data);
  const rows = [_exportHeaders, ...data.map(_rowToArray)];

  const csvContent = rows
    .map((r) =>
      r
        .map((cell) => {
          const str = String(cell || "").replace(/"/g, '""');
          return `"${str}"`;
        })
        .join(",")
    )
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `autoazubi_leads_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── Excel Export ─────────────────────────────────────────────────────────────────

/**
 * Download scraped data as a properly formatted .xlsx file using SheetJS.
 * Handles German umlauts correctly — no encoding issues in Excel.
 * @param {Array<Object>} data - Array of scraped lead objects
 */
window.downloadExcel = function downloadExcel(data) {
  if (typeof XLSX === "undefined") {
    console.error("SheetJS not loaded — cannot export Excel.");
    return;
  }
  data = _deduplicateData(data);

  const rows = [_exportHeaders, ...data.map(_rowToArray)];

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Auto-size columns based on content
  ws["!cols"] = _exportHeaders.map((h, i) => {
    let maxLen = h.length;
    data.forEach((row) => {
      const val = String(_rowToArray(row)[i] || "");
      if (val.length > maxLen) maxLen = val.length;
    });
    return { wch: Math.min(maxLen + 2, 40) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");

  XLSX.writeFile(
    wb,
    `autoazubi_leads_${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
};



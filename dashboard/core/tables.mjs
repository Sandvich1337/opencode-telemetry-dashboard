import {
  cell,
  escapeHtml,
  firstDefined,
  fmt,
  hasValue,
  numeric,
} from "./format.mjs";

export function createTableRenderer() {
  const sortStates = new Map();
  const tableModels = new Map();
  const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  const numericColumn = (key, label, value, format = fmt) => ({
    key,
    label,
    className: "num",
    value: (row) => numeric(value(row)),
    format,
  });

  const textSortValue = (value) => {
    if (!hasValue(value)) return null;
    if (typeof value === "object") {
      return textSortValue(firstDefined(value.name, value.label, value.url));
    }
    return String(value);
  };

  const sortValueMissing = (value) => {
    if (Array.isArray(value)) return !value.length || value.every(sortValueMissing);
    if (value && typeof value === "object") return Object.keys(value).length === 0;
    return !hasValue(value) || (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.trim() === "");
  };

  const compareSortValues = (left, right, direction) => {
    const leftMissing = sortValueMissing(left);
    const rightMissing = sortValueMissing(right);
    if (leftMissing || rightMissing) {
      if (leftMissing === rightMissing) return 0;
      return leftMissing ? 1 : -1;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      const leftValues = Array.isArray(left) ? left : [left];
      const rightValues = Array.isArray(right) ? right : [right];
      for (let index = 0; index < Math.max(leftValues.length, rightValues.length); index += 1) {
        const comparison = compareSortValues(leftValues[index], rightValues[index], direction);
        if (comparison) return comparison;
      }
      return 0;
    }
    const comparison = typeof left === "number" && typeof right === "number"
      ? left - right
      : sortCollator.compare(String(left), String(right));
    return direction === "desc" ? -comparison : comparison;
  };

  const sortedTableRows = (rows, tableKey, columns) => {
    const state = sortStates.get(tableKey);
    const column = state && columns.find((entry) => entry.key === state.column && entry.sortable !== false);
    if (!column) return rows;
    return rows.map((row, index) => ({ row, index })).sort((left, right) => {
      const comparison = compareSortValues(column.value(left.row), column.value(right.row), state.direction);
      return comparison || left.index - right.index;
    }).map(({ row }) => row);
  };

  const sortableHeader = (tableKey, column) => {
    const state = sortStates.get(tableKey);
    const active = state?.column === column.key;
    const direction = active ? state.direction : "";
    const directionLabel = direction === "desc" ? "descending" : "ascending";
    const nextDirection = active && direction === "asc" ? "descending" : "ascending";
    const className = [column.className, column.sortable === false ? "" : "sortable"].filter(Boolean).join(" ");
    if (column.sortable === false) return `<th scope="col" class="${escapeHtml(className)}">${escapeHtml(column.label)}</th>`;
    const ariaLabel = active
      ? `Sort by ${column.label}; currently ${directionLabel}; activate to sort ${nextDirection}`
      : `Sort by ${column.label}; activate to sort ascending`;
    const indicator = active ? (direction === "desc" ? "▼" : "▲") : "↕";
    const ariaSort = active ? directionLabel : "none";
    return `<th scope="col" aria-sort="${ariaSort}" class="${escapeHtml(className)}">
      <button type="button" class="sort-button ${escapeHtml(column.className || "")}" data-sort-table="${escapeHtml(tableKey)}" data-sort-column="${escapeHtml(column.key)}" aria-label="${escapeHtml(ariaLabel)}">
        <span>${escapeHtml(column.label)}</span><span class="sort-indicator" aria-hidden="true">${indicator}</span>
      </button>
    </th>`;
  };

  const renderDataTableModel = (model) => {
    const { tableKey, rows, columns, emptyMessage } = model;
    const host = `data-table-host="${escapeHtml(tableKey)}"`;
    if (!rows.length) return `<div class="table-host" ${host}><div class="empty">${escapeHtml(emptyMessage)}</div></div>`;
    const orderedRows = sortedTableRows(rows, tableKey, columns);
    const body = orderedRows.map((row) => `<tr>${columns.map((column) => {
      const value = column.value(row);
      return cell(column.format ? column.format(value, row) : value, column.className || "");
    }).join("")}</tr>`).join("");
    return `<div class="table-host" ${host}><div class="table-scroll"><table data-sort-table="${escapeHtml(tableKey)}" aria-label="${escapeHtml(tableKey)} data"><thead><tr>${columns.map((column) => sortableHeader(tableKey, column)).join("")}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  };

  const renderDataTable = (tableKey, source, columns, emptyMessage) => {
    const model = { tableKey, rows: Array.isArray(source) ? source : [], columns, emptyMessage };
    tableModels.set(tableKey, model);
    return renderDataTableModel(model);
  };

  const rerenderDataTable = (tableKey, root) => {
    const model = tableModels.get(tableKey);
    if (!model) return;
    const host = [...root.querySelectorAll("[data-table-host]")]
      .find((element) => element.dataset.tableHost === tableKey);
    if (host) host.outerHTML = renderDataTableModel(model);
  };

  const toggleSort = (tableKey, column) => {
    const current = sortStates.get(tableKey);
    const direction = current?.column === column && current.direction === "asc" ? "desc" : "asc";
    sortStates.set(tableKey, { column, direction });
  };

  return Object.freeze({
    numericColumn,
    textSortValue,
    renderDataTable,
    rerenderDataTable,
    toggleSort,
    clear() {
      tableModels.clear();
    },
  });
}

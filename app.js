// ==========================================
// ESTADO GLOBAL
// ==========================================
let currentUser = null;
let masterCajas = { ...INITIAL_CAJAS_POR_PALETA };
let masterUbicaciones = { ...INITIAL_UBICACIONES };

let rawSapGloriaRows = [];     // Filas filtradas de Gloria + Lima + Pendientes
let availableSapDates = [];    // [{ dateISO: '2026-11-20', count: 20, selected: true }]
let parsedSapRows = [];        // Filas acumuladas en la vista previa
let lastProcessedDatesKey = ""; // Huella exacta de las fechas ya procesadas
let hasPublishedCurrentTarget = false; // Indica si la fecha operativa ya tiene programa publicado

let dailyProgram = [];
let dailyTrips = [];
let tripBuilderItems = [];

let unsubProgram = null;
let unsubTrips = null;

function getTodayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().split("T")[0];
}

function formatSAPDateToISO(val) {
  if (!val) return "";
  if (typeof val === "string" && val.includes(".")) {
    const [d, m, y] = val.trim().split(".");
    if (d && m && y) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (val instanceof Date) {
    return val.toISOString().split("T")[0];
  }
  return String(val);
}

function formatISOToDisplay(iso) {
  if (!iso || !iso.includes("-")) return iso;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function setElementVisible(elOrId, visible) {
  const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  if (visible) {
    el.classList.remove("hidden");
    el.style.display = "";
  } else {
    el.classList.add("hidden");
    el.style.display = "none";
  }
}

function getSelectedDatesKey() {
  return availableSapDates
    .filter((d) => d.selected)
    .map((d) => d.dateISO)
    .sort()
    .join("|");
}

function getRowUniqueKey(row) {
  return `${String(row.pedido || "").trim()}_${String(row.material || "").trim()}_${String(row.orden || "").trim()}`;
}

// ==========================================
// INICIALIZACIÓN Y SESIÓN
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  const today = getTodayISO();
  document.getElementById("currentDateLabel").textContent = `Fecha Operativa: ${formatISOToDisplay(today)}`;
  document.getElementById("publishTargetDateInput").value = today;
  document.getElementById("monitorDateInput").value = today;

  // Escuchar maestros en tiempo real y ocultar el botón de sincronización si ya existen
  db.collection("maestros").doc("cajasPorPaleta").onSnapshot((doc) => {
    const btnSync = document.getElementById("btnSyncMasters");
    if (doc.exists && Object.keys(doc.data() || {}).length > 0) {
      masterCajas = { ...INITIAL_CAJAS_POR_PALETA, ...doc.data() };
      localStorage.setItem("trupal_masters_synced", "true");
      setElementVisible(btnSync, false);
    } else if (!localStorage.getItem("trupal_masters_synced")) {
      setElementVisible(btnSync, true);
    }
  });

  db.collection("maestros").doc("ubicaciones").onSnapshot((doc) => {
    if (doc.exists) masterUbicaciones = { ...INITIAL_UBICACIONES, ...doc.data() };
  });

  const saved = localStorage.getItem("trupal_gloria_user");
  if (saved) {
    const u = JSON.parse(saved);
    selectUser(u.role, u.name);
  }
});

function selectUser(role, name) {
  currentUser = { role, name };
  localStorage.setItem("trupal_gloria_user", JSON.stringify(currentUser));

  setElementVisible("loginView", false);
  setElementVisible("auditorView", false);
  setElementVisible("driverView", false);
  setElementVisible("forkliftView", false);
  setElementVisible("btnChangeUser", true);

  if (role === "AUDITOR") {
    setElementVisible("auditorView", true);
    switchAuditorTab("cargar");
    subscribeToDayData(document.getElementById("monitorDateInput").value);
    checkTargetDatePublishedStatus();
  } else if (role === "CONDUCTOR") {
    setElementVisible("driverView", true);
    setupDriverView();
    subscribeToDayData(getTodayISO());
  } else if (role === "MONTACARGA") {
    setElementVisible("forkliftView", true);
    document.getElementById("forkliftBadgeName").textContent = name;
    subscribeToDayData(getTodayISO());
  }
}

function logoutUser() {
  localStorage.removeItem("trupal_gloria_user");
  currentUser = null;
  setElementVisible("btnChangeUser", false);
  setElementVisible("auditorView", false);
  setElementVisible("driverView", false);
  setElementVisible("forkliftView", false);
  setElementVisible("loginView", true);
}

function switchAuditorTab(tabName) {
  ["cargar", "viajes", "estado"].forEach((t) => {
    setElementVisible(`auditorTab_${t}`, t === tabName);
    const tabBtn = document.getElementById(`tabBtn_${t}`);
    if (tabBtn) tabBtn.classList.toggle("active", t === tabName);
  });

  const showMonitorWidgets = tabName !== "cargar";
  setElementVisible("auditorKpiGrid", showMonitorWidgets);
  setElementVisible("auditorGlobalControls", showMonitorWidgets);
}

function toggleCollapseSection(bodyId, btnId, forceExpand = null) {
  const body = document.getElementById(bodyId);
  const btn = document.getElementById(btnId);
  if (!body || !btn) return;

  const isCurrentlyHidden = body.classList.contains("hidden") || body.style.display === "none";
  const shouldShow = forceExpand !== null ? forceExpand : isCurrentlyHidden;

  setElementVisible(body, shouldShow);
  btn.textContent = shouldShow ? "➖ Minimizar" : "➕ Maximizar";
}

async function initMasterDataIfNeeded() {
  try {
    await db.collection("maestros").doc("cajasPorPaleta").set(masterCajas, { merge: true });
    await db.collection("maestros").doc("ubicaciones").set(masterUbicaciones, { merge: true });
    localStorage.setItem("trupal_masters_synced", "true");
    setElementVisible("btnSyncMasters", false);
    alert("✅ Tablas maestras sincronizadas en la nube. Este botón ya no volverá a mostrarse.");
  } catch (e) {
    alert("Error sincronizando maestros: " + e.message);
  }
}

// ==========================================
// SUSCRIPCIÓN EN TIEMPO REAL POR FECHA
// ==========================================
function subscribeToDayData(dateStr) {
  const targetDate = dateStr || document.getElementById("monitorDateInput")?.value || getTodayISO();
  if (unsubProgram) unsubProgram();
  if (unsubTrips) unsubTrips();

  unsubProgram = db.collection("programas").doc(targetDate).onSnapshot((doc) => {
    dailyProgram = doc.exists ? (doc.data().items || []) : [];
    renderAllViews();
  });

  unsubTrips = db.collection("viajes")
    .where("fechaOperativa", "==", targetDate)
    .onSnapshot((snap) => {
      dailyTrips = [];
      snap.forEach((d) => dailyTrips.push({ id: d.id, ...d.data() }));
      dailyTrips.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      renderAllViews();
    });
}

function renderAllViews() {
  if (!currentUser) return;
  if (currentUser.role === "AUDITOR") renderAuditorDashboard();
  if (currentUser.role === "CONDUCTOR") {
    populateDriverMaterialDropdown();
    renderDriverMyTrips();
  }
  if (currentUser.role === "MONTACARGA") renderForkliftTrips();
}

// ==========================================
// MÓDULO 1: AUDITOR (SAP MULTI-FECHA ACUMULATIVO)
// ==========================================
async function checkTargetDatePublishedStatus() {
  const targetDate = document.getElementById("publishTargetDateInput")?.value;
  if (!targetDate) return;
  try {
    const doc = await db.collection("programas").doc(targetDate).get();
    hasPublishedCurrentTarget = doc.exists && Array.isArray(doc.data()?.items) && doc.data().items.length > 0;
  } catch (e) {
    hasPublishedCurrentTarget = false;
  }
  updatePublishActionButton(false);
}

function updatePublishActionButton(hasPendingChanges) {
  const btnPub = document.getElementById("btnPublishDailyProgram");
  const badgePub = document.getElementById("publishedStatusBadge");
  const targetDate = document.getElementById("publishTargetDateInput")?.value || getTodayISO();
  if (!btnPub || !badgePub) return;

  if (!hasPublishedCurrentTarget) {
    // Primer programa del día: siempre muestra "Publicar Programa del Día en Vivo"
    btnPub.textContent = "✅ Publicar Programa del Día en Vivo";
    setElementVisible(btnPub, true);
    setElementVisible(badgePub, false);
  } else if (hasPendingChanges) {
    // Ya estaba publicado, pero se agregaron nuevas fechas o modificaron filas: muestra "Actualizar Programa"
    btnPub.textContent = "🔄 Actualizar Programa del Día";
    setElementVisible(btnPub, true);
    setElementVisible(badgePub, false);
  } else {
    // Ya publicado y sin cambios pendientes: ocultar botón y mostrar insignia
    setElementVisible(btnPub, false);
    badgePub.textContent = `✅ Programa Publicado (${formatISOToDisplay(targetDate)})`;
    setElementVisible(badgePub, true);
  }
}

function syncProcessButtonVisibility() {
  const currentKey = getSelectedDatesKey();
  // Si no hay fechas seleccionadas o si son exactamente las mismas que ya se procesaron, ocultar el botón
  const shouldShow = currentKey !== "" && currentKey !== lastProcessedDatesKey;
  setElementVisible("processDatesBtnWrap", shouldShow);
}

function loadSapFileDates() {
  const fileInput = document.getElementById("sapFileInput");
  if (!fileInput.files.length) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames.includes("Tabla") ? "Tabla" : workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    // Filtrar estrictamente: GLORIA + Región LIMA + Status PV (No tratado / Tratado parcialmente)
    rawSapGloriaRows = rows.filter((r) => {
      const dest = String(r["Razón Social del Dest. de Mercancía"] || "").toUpperCase();
      const client = String(r["Razón social"] || "").toUpperCase();
      const isGloria = dest.includes("GLORIA") || client.includes("GLORIA");

      const region = String(r["Región/Distrito"] || "").trim().toUpperCase();
      const isLima = region === "LIMA";

      const statusPV = String(r["Status del PV"] || "").trim().toUpperCase();
      const isPendingStatus = statusPV === "NO TRATADO" || statusPV === "TRATADO PARCIALMENTE";

      return isGloria && isLima && isPendingStatus;
    });

    const countsByDate = {};
    rawSapGloriaRows.forEach((r) => {
      const dISO = formatSAPDateToISO(r["Fe.pref.entrg."]);
      if (dISO) countsByDate[dISO] = (countsByDate[dISO] || 0) + 1;
    });

    const today = getTodayISO();
    lastProcessedDatesKey = ""; // Reiniciar huella al leer nuevo archivo
    availableSapDates = Object.keys(countsByDate)
      .sort()
      .map((d) => ({
        dateISO: d,
        count: countsByDate[d],
        selected: d === today
      }));

    toggleCollapseSection("sapDatesCollapseBody", "btnToggleDatesCollapse", true);
    renderSapDateChips();
    syncProcessButtonVisibility();
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
}

function renderSapDateChips() {
  const box = document.getElementById("sapDatesSelectorBox");
  const container = document.getElementById("sapDateChipsContainer");
  if (!availableSapDates.length) {
    setElementVisible(box, false);
    return alert("No se encontraron pedidos de GLORIA (Región LIMA - No tratado / Tratado parcialmente) en este archivo.");
  }

  setElementVisible(box, true);
  container.innerHTML = availableSapDates.map((item, idx) => `
    <label class="date-chip ${item.selected ? 'selected' : ''}" onclick="toggleSapDateChip(${idx}, event)">
      <input type="checkbox" ${item.selected ? 'checked' : ''} onchange="event.stopPropagation(); toggleSapDateChip(${idx})" />
      <span>${formatISOToDisplay(item.dateISO)}</span>
      <span class="chip-count">${item.count} ped.</span>
    </label>
  `).join("");
}

function toggleSapDateChip(idx, event) {
  if (event && event.target.tagName === "INPUT") return;
  availableSapDates[idx].selected = !availableSapDates[idx].selected;
  renderSapDateChips();
  syncProcessButtonVisibility();
}

function toggleAllSapDates(state) {
  availableSapDates.forEach((d) => (d.selected = state));
  renderSapDateChips();
  syncProcessButtonVisibility();
}

async function processSelectedSapDates() {
  const selectedSet = new Set(availableSapDates.filter((d) => d.selected).map((d) => d.dateISO));
  if (!selectedSet.size) return alert("Marca al menos una fecha de entrega para procesar.");

  const targetDate = document.getElementById("publishTargetDateInput").value;

  // 1. Obtener los pedidos que YA existen publicados en la nube para esa fecha operativa (para nunca perderlos)
  let existingPublishedItems = [];
  if (targetDate) {
    try {
      const doc = await db.collection("programas").doc(targetDate).get();
      if (doc.exists && Array.isArray(doc.data()?.items)) {
        existingPublishedItems = doc.data().items;
        hasPublishedCurrentTarget = existingPublishedItems.length > 0;
      }
    } catch (e) {
      console.warn("No se pudo leer programa previo:", e);
    }
  }

  // 2. Mapear las filas recién seleccionadas desde SAP
  const newlyMappedRows = rawSapGloriaRows
    .filter((r) => selectedSet.has(formatSAPDateToISO(r["Fe.pref.entrg."])))
    .map((r, idx) => {
      const mat = String(r["Material"] || "").trim();
      const ubi = masterUbicaciones[mat] || "SIN UBICACIÓN";
      const cajasPal = masterCajas[mat] || 0;
      const canPed = Number(r["CanPed."]) || 0;
      return {
        uid: `${r["Pedido"]}_${mat}_${idx}`,
        incluir: true,
        material: mat,
        textoBreve: String(r["Texto Breve"] || "").trim(),
        oc: String(r["O/C"] || "").trim(),
        fePrefEntrg: formatSAPDateToISO(r["Fe.pref.entrg."]),
        canPed: canPed,
        stockEspecial: Number(r["Stock Especial"]) || 0,
        pedido: String(r["Pedido"] || "").trim(),
        orden: r["Orden"] ? String(Math.trunc(Number(r["Orden"]))) : "",
        ubicacion: ubi,
        cajasPorPaletaRef: cajasPal,
        canPalletsEst: cajasPal > 0 ? Math.ceil(canPed / cajasPal) : 0
      };
    });

  // 3. FUSIÓN ACUMULATIVA: Conservar lo ya publicado + lo que ya estaba en vista previa + adicionar las nuevas filas sin duplicar
  const mergedMap = new Map();

  // Primero cargamos lo que ya estaba publicado en la nube para esa fecha operativa
  existingPublishedItems.forEach((item) => {
    mergedMap.set(getRowUniqueKey(item), { ...item, incluir: true });
  });

  // Luego conservamos lo que el auditor ya tuviera en pantalla (si aún no había publicado)
  parsedSapRows.forEach((item) => {
    const k = getRowUniqueKey(item);
    if (!mergedMap.has(k)) {
      mergedMap.set(k, item);
    }
  });

  // Finalmente adicionamos los pedidos de las nuevas fechas seleccionadas
  let addedCount = 0;
  newlyMappedRows.forEach((item) => {
    const k = getRowUniqueKey(item);
    if (!mergedMap.has(k)) {
      mergedMap.set(k, item);
      addedCount++;
    }
  });

  parsedSapRows = Array.from(mergedMap.values());
  parsedSapRows.sort((a, b) => a.fePrefEntrg.localeCompare(b.fePrefEntrg) || a.material.localeCompare(b.material));

  // Guardar la huella de fechas procesadas y ocultar el botón Procesar
  lastProcessedDatesKey = getSelectedDatesKey();
  syncProcessButtonVisibility();

  // Mostrar el botón Publicar (si es 1ra vez) o Actualizar Programa (si ya existía programa)
  updatePublishActionButton(true);
  toggleCollapseSection("sapPreviewCollapseBody", "btnTogglePreviewCollapse", true);

  const uniqueDatesInTable = Array.from(new Set(parsedSapRows.map((r) => r.fePrefEntrg)))
    .sort()
    .map(formatISOToDisplay)
    .join(", ");

  renderSapPreview(uniqueDatesInTable, addedCount);
}

async function onTargetDateChange() {
  parsedSapRows = [];
  lastProcessedDatesKey = "";
  setElementVisible("sapPreviewBox", false);
  syncProcessButtonVisibility();
  await checkTargetDatePublishedStatus();
}

function toggleRowInclusion(idx, isChecked) {
  parsedSapRows[idx].incluir = isChecked;
  updatePublishActionButton(true);
}

function renderSapPreview(datesListText, addedCount = 0) {
  const box = document.getElementById("sapPreviewBox");
  const tbody = document.querySelector("#sapPreviewTable tbody");
  setElementVisible(box, true);

  const extraMsg = hasPublishedCurrentTarget
    ? ` (Se adicionaron ${addedCount} pedidos nuevos al programa existente).`
    : `. Desmarca los que no salgan y publica.`;

  document.getElementById("sapSummaryText").textContent =
    `Total acumulado: ${parsedSapRows.length} pedidos de GLORIA (Fechas incluidas: ${datesListText})${extraMsg}`;

  tbody.innerHTML = parsedSapRows.map((row, i) => `
    <tr>
      <td><input type="checkbox" style="width:18px;height:18px;" ${row.incluir ? "checked" : ""} onchange="toggleRowInclusion(${i}, this.checked)" /></td>
      <td><strong>${row.material}</strong></td>
      <td>${row.textoBreve}</td>
      <td>${row.oc}</td>
      <td><strong>${formatISOToDisplay(row.fePrefEntrg)}</strong></td>
      <td>${row.canPed.toLocaleString()}</td>
      <td>${row.stockEspecial.toLocaleString()}</td>
      <td>${row.pedido}</td>
      <td>${row.orden}</td>
      <td><span class="badge ${row.ubicacion === 'SIN UBICACIÓN' ? 'badge-warn' : 'badge-ok'}">${row.ubicacion}</span></td>
    </tr>
  `).join("");
}

async function publishDailyProgram() {
  const targetDate = document.getElementById("publishTargetDateInput").value;
  if (!targetDate) return alert("Selecciona la Fecha Operativa en la que se publicará este programa.");

  const selected = parsedSapRows.filter((r) => r.incluir);
  if (!selected.length) return alert("No hay filas seleccionadas para publicar.");

  const wasAlreadyPublished = hasPublishedCurrentTarget;

  await db.collection("programas").doc(targetDate).set({
    fechaOperativa: targetDate,
    updatedAt: Date.now(),
    items: selected
  });

  hasPublishedCurrentTarget = true;
  updatePublishActionButton(false);

  document.getElementById("monitorDateInput").value = targetDate;
  subscribeToDayData(targetDate);
  switchAuditorTab("estado");

  const actionWord = wasAlreadyPublished ? "actualizado" : "publicado";
  alert(`✅ Programa ${actionWord} correctamente (${selected.length} materiales acumulados) para el ${formatISOToDisplay(targetDate)}.`);
}

function renderAuditorDashboard() {
  let totalPaletas = 0, totalGloria = 0, totalTrupal = 0, totalCajas = 0;
  const aggByProgramUid = {};

  dailyTrips.forEach((t) => {
    totalPaletas += Number(t.totalPaletasConfirmadas || 0);
    (t.items || []).forEach((it) => {
      totalCajas += Number(it.totalCajas || 0);
      totalGloria += Number(it.paletasGloria || 0);
      totalTrupal += Number(it.paletasTrupal || 0);

      const key = it.programUid || it.material;
      if (!aggByProgramUid[key]) aggByProgramUid[key] = { cajas: 0, paletas: 0, gloria: 0, trupal: 0 };
      aggByProgramUid[key].cajas += Number(it.totalCajas || 0);
      aggByProgramUid[key].paletas += Number(it.totalPaletas || 0);
      aggByProgramUid[key].gloria += Number(it.paletasGloria || 0);
      aggByProgramUid[key].trupal += Number(it.paletasTrupal || 0);
    });
  });

  document.getElementById("kpiViajes").textContent = dailyTrips.length;
  document.getElementById("kpiPaletas").textContent = totalPaletas;
  document.getElementById("kpiGloria").textContent = totalGloria;
  document.getElementById("kpiTrupal").textContent = totalTrupal;
  document.getElementById("kpiCajas").textContent = totalCajas.toLocaleString();

  document.getElementById("badgeTabViajes").textContent = dailyTrips.length;
  document.getElementById("badgeTabProgram").textContent = dailyProgram.length;

  // Pestaña B: Tarjetas de viajes en vivo
  const tripsDiv = document.getElementById("liveTripsContainer");
  if (!dailyTrips.length) {
    tripsDiv.innerHTML = `<p class="subtitle">Aún no hay viajes registrados en esta fecha operativa.</p>`;
  } else {
    tripsDiv.innerHTML = dailyTrips.map((t) => {
      const hora = new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const clasificado = t.estadoMontacarga === "CLASIFICADO";
      return `
        <div class="trip-card ${clasificado ? 'completed' : 'pending-forklift'}">
          <div class="card-header">
            <div>
              <strong>Orden Salida N° ${t.ordenSalida}</strong> — 🚛 ${t.conductor} (${t.placa})
              <div class="item-meta">Hora salida: ${hora} | Total unidad: <strong>${t.totalPaletasConfirmadas} paletas</strong> | Montacarguista: <strong>${t.montacarguista || 'Pendiente'}</strong></div>
            </div>
            <span class="badge ${clasificado ? 'badge-ok' : 'badge-warn'}">
              ${clasificado ? '✅ Paletas Clasificadas' : '⏳ Falta Montacarguista'}
            </span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Material</th><th>Descripción</th><th>Orden SAP</th><th>Desglose Carga</th><th>Cajas</th><th>Paletas</th><th>Gloria</th><th>Trupal</th></tr></thead>
              <tbody>
                ${(t.items || []).map(it => `
                  <tr>
                    <td><strong>${it.material}</strong></td>
                    <td>${it.textoBreve}</td>
                    <td>${it.orden || '-'}</td>
                    <td>${it.resumenCalculo}</td>
                    <td><strong>${it.totalCajas.toLocaleString()}</strong></td>
                    <td>${it.totalPaletas}</td>
                    <td>${it.paletasGloria ?? '-'}</td>
                    <td>${it.paletasTrupal ?? '-'}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }).join("");
  }

  // Pestaña C: Tabla consolidada del programa con buscador
  const searchFilter = (document.getElementById("programSearchInput")?.value || "").toLowerCase().trim();
  const filteredProgram = dailyProgram.filter((p) => {
    if (!searchFilter) return true;
    return (
      p.material.toLowerCase().includes(searchFilter) ||
      p.textoBreve.toLowerCase().includes(searchFilter) ||
      String(p.orden).toLowerCase().includes(searchFilter) ||
      String(p.pedido).toLowerCase().includes(searchFilter)
    );
  });

  const progBody = document.querySelector("#programStatusTable tbody");
  if (!filteredProgram.length) {
    progBody.innerHTML = `<tr><td colspan="13" style="text-align:center; color:#64748b;">No hay líneas de programa para mostrar en esta fecha.</td></tr>`;
    return;
  }

  progBody.innerHTML = filteredProgram.map((p) => {
    const st = aggByProgramUid[p.uid] || { cajas: 0, paletas: 0, gloria: 0, trupal: 0 };
    const saldoPend = Math.max(0, p.canPed - st.cajas);
    const statusText = st.cajas === 0 ? "PENDIENTE" : (st.cajas >= p.canPed ? "DESPACHADO" : "PARCIAL");
    return `
      <tr>
        <td><strong>${p.material}</strong></td>
        <td>${p.textoBreve}</td>
        <td>${masterUbicaciones[p.material] || p.ubicacion}</td>
        <td>${p.oc}</td>
        <td>${formatISOToDisplay(p.fePrefEntrg)}</td>
        <td>${p.pedido} / ${p.orden}</td>
        <td>${p.canPed.toLocaleString()}</td>
        <td><strong>${st.cajas.toLocaleString()}</strong></td>
        <td>${saldoPend.toLocaleString()}</td>
        <td>${st.paletas}</td>
        <td>${st.gloria}</td>
        <td>${st.trupal}</td>
        <td><span class="badge ${statusText === 'DESPACHADO' ? 'badge-ok' : 'badge-warn'}">${statusText}</span></td>
      </tr>
    `;
  }).join("");
}

function exportReqExcel() {
  const dateStr = document.getElementById("monitorDateInput").value;
  if (!dailyProgram.length && !dailyTrips.length) return alert("No hay datos para exportar.");

  const aggByProgramUid = {};
  dailyTrips.forEach((t) => {
    (t.items || []).forEach((it) => {
      const key = it.programUid || it.material;
      if (!aggByProgramUid[key]) aggByProgramUid[key] = { cajas: 0, paletas: 0, gloria: 0, trupal: 0 };
      aggByProgramUid[key].cajas += Number(it.totalCajas || 0);
      aggByProgramUid[key].paletas += Number(it.totalPaletas || 0);
      aggByProgramUid[key].gloria += Number(it.paletasGloria || 0);
      aggByProgramUid[key].trupal += Number(it.paletasTrupal || 0);
    });
  });

  const rowsReq = dailyProgram.map((p) => {
    const st = aggByProgramUid[p.uid] || { cajas: 0, paletas: 0, gloria: 0, trupal: 0 };
    return {
      "Material": p.material,
      "Texto Breve": p.textoBreve,
      "O/C": p.oc,
      "Fe.pref.entrg.": formatISOToDisplay(p.fePrefEntrg),
      "CanPed.": p.canPed,
      "Stock Especial": p.stockEspecial,
      "Pedido": p.pedido,
      "Orden": p.orden,
      "Ubicación": masterUbicaciones[p.material] || p.ubicacion,
      "CanPallets": st.paletas,
      "Cajas Reales Cargadas": st.cajas,
      "Observaciones": st.cajas > 0 ? (st.cajas >= p.canPed ? "DESPACHADO" : "PARCIAL") : "PENDIENTE",
      "Gloria": st.gloria || "",
      "Trupal": st.trupal || ""
    };
  });

  const rowsViajes = [];
  dailyTrips.forEach((t) => {
    (t.items || []).forEach((it) => {
      rowsViajes.push({
        "Fecha": t.fechaOperativa,
        "Hora": new Date(t.timestamp).toLocaleTimeString(),
        "Orden Salida": t.ordenSalida,
        "Conductor": t.conductor,
        "Placa": t.placa,
        "Montacarguista": t.montacarguista || "Pendiente",
        "Material": it.material,
        "Descripción": it.textoBreve,
        "Orden SAP": it.orden,
        "Desglose Paletas": it.resumenCalculo,
        "Cantidad Cajas": it.totalCajas,
        "Total Paletas Item": it.totalPaletas,
        "Paletas Gloria": it.paletasGloria ?? 0,
        "Paletas Trupal": it.paletasTrupal ?? 0,
        "Total Paletas Unidad": t.totalPaletasConfirmadas
      });
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsReq), "Req_Requerimiento");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsViajes), "Detalle_Ordenes_Salida");

  const [y, m, d] = dateStr.split("-");
  XLSX.writeFile(wb, `Req Requerimiento ${d}.${m}.${y}.xlsx`);
}

// ==========================================
// MÓDULO 2: CONDUCTOR (PLACA DIARIA + CARGA)
// ==========================================
function getPlateStorageKey() {
  return `plate_${currentUser.name}_${getTodayISO()}`;
}

function setupDriverView() {
  const savedPlate = localStorage.getItem(getPlateStorageKey());
  if (!savedPlate) {
    document.getElementById("driverNamePlate").textContent = currentUser.name;
    setElementVisible("plateSetupCard", true);
    setElementVisible("driverTripCard", false);
  } else {
    setElementVisible("plateSetupCard", false);
    setElementVisible("driverTripCard", true);
    document.getElementById("driverBadgeName").textContent = currentUser.name;
    document.getElementById("driverBadgePlate").textContent = savedPlate;
  }
  renderTripBuilder();
}

function saveDailyPlate() {
  const val = document.getElementById("dailyPlateInput").value.trim().toUpperCase();
  if (!val) return alert("Por favor ingresa la placa de la unidad.");
  localStorage.setItem(getPlateStorageKey(), val);
  setupDriverView();
}

function editDailyPlate() {
  const current = localStorage.getItem(getPlateStorageKey()) || "";
  document.getElementById("dailyPlateInput").value = current;
  setElementVisible("plateSetupCard", true);
  setElementVisible("driverTripCard", false);
}

function populateDriverMaterialDropdown() {
  const sel = document.getElementById("materialSelect");
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">-- Selecciona un material (${dailyProgram.length} disponibles) --</option>` +
    dailyProgram.map((p) => {
      const ubi = masterUbicaciones[p.material] || p.ubicacion;
      return `<option value="${p.uid}">${p.material} | ${p.textoBreve} (Orden: ${p.orden || 'S/N'} - Ubic: ${ubi})</option>`;
    }).join("");
  sel.value = currentVal;
}

function addMaterialToTrip() {
  const uid = document.getElementById("materialSelect").value;
  if (!uid) return alert("Selecciona un material de la lista.");
  const progItem = dailyProgram.find((p) => p.uid === uid);
  if (!progItem) return;

  const currentUbi = masterUbicaciones[progItem.material] || progItem.ubicacion;
  const sinUbicacion = !currentUbi || currentUbi === "SIN UBICACIÓN" || currentUbi === "#N/A";
  const defaultCajasPal = masterCajas[progItem.material] || "";

  tripBuilderItems.push({
    programUid: progItem.uid,
    material: progItem.material,
    textoBreve: progItem.textoBreve,
    orden: progItem.orden,
    pedido: progItem.pedido,
    sinUbicacion: sinUbicacion,
    ubicacionActual: sinUbicacion ? "" : currentUbi,
    cajasPorPaletaStd: defaultCajasPal,
    cantPaletasStd: "",
    saldos: []
  });

  document.getElementById("materialSelect").value = "";
  renderTripBuilder();
}

function addSaldoRow(itemIdx) {
  tripBuilderItems[itemIdx].saldos.push({ cajasPorPaleta: "", cantPaletas: 1 });
  renderTripBuilder();
}

function removeSaldoRow(itemIdx, saldoIdx) {
  tripBuilderItems[itemIdx].saldos.splice(saldoIdx, 1);
  renderTripBuilder();
}

function removeTripItem(itemIdx) {
  tripBuilderItems.splice(itemIdx, 1);
  renderTripBuilder();
}

function updateItemField(itemIdx, field, val) {
  tripBuilderItems[itemIdx][field] = val;
  recalculateTripTotals();
}

function updateSaldoField(itemIdx, saldoIdx, field, val) {
  tripBuilderItems[itemIdx].saldos[saldoIdx][field] = val;
  recalculateTripTotals();
}

function computeItemTotals(it) {
  const cStd = Number(it.cajasPorPaletaStd) || 0;
  const pStd = Number(it.cantPaletasStd) || 0;
  let cajas = cStd * pStd;
  let paletas = pStd;

  const parts = [];
  if (pStd > 0) parts.push(`${pStd} pal x ${cStd}`);

  (it.saldos || []).forEach((s) => {
    const cs = Number(s.cajasPorPaleta) || 0;
    const ps = Number(s.cantPaletas) || 0;
    if (ps > 0 && cs > 0) {
      cajas += cs * ps;
      paletas += ps;
      parts.push(`${ps} saldo x ${cs}`);
    }
  });

  return {
    totalCajas: cajas,
    totalPaletas: paletas,
    resumenCalculo: parts.join(" + ") || "0 paletas"
  };
}

function recalculateTripTotals() {
  let grandCajas = 0;
  let grandPaletas = 0;

  tripBuilderItems.forEach((it, idx) => {
    const calc = computeItemTotals(it);
    grandCajas += calc.totalCajas;
    grandPaletas += calc.totalPaletas;
    const subEl = document.getElementById(`itemSubtotal_${idx}`);
    if (subEl) {
      subEl.innerHTML = `<span>Paletas: ${calc.totalPaletas}</span><span>Total Cajas: ${calc.totalCajas.toLocaleString()}</span>`;
    }
  });

  document.getElementById("tripCalcCajas").textContent = grandCajas.toLocaleString();
  document.getElementById("tripCalcPaletas").textContent = grandPaletas;
}

function renderTripBuilder() {
  const container = document.getElementById("tripItemsContainer");
  if (!tripBuilderItems.length) {
    container.innerHTML = `<p class="subtitle">Agrega los materiales que cargaste en esta unidad.</p>`;
    recalculateTripTotals();
    return;
  }

  container.innerHTML = tripBuilderItems.map((it, idx) => {
    const calc = computeItemTotals(it);
    return `
      <div class="item-card">
        <div class="item-card-header">
          <div>
            <div class="item-title">${it.material} — ${it.textoBreve}</div>
            <div class="item-meta">Orden SAP: <strong>${it.orden || 'S/N'}</strong> | Ubicación: <strong>${it.sinUbicacion ? '⚠️ REQUERIDA' : it.ubicacionActual}</strong></div>
          </div>
          <button type="button" class="btn-danger" onclick="removeTripItem(${idx})">Quitar</button>
        </div>

        ${it.sinUbicacion ? `
          <div class="field" style="margin-bottom:8px; background:#fef3c7; padding:8px; border-radius:6px;">
            <label>⚠️ Material sin ubicación registrada. Indica dónde lo recogiste (se guardará en el maestro):</label>
            <input type="text" placeholder="Ej: TOLDO HUACHIPA 04 o HP04-E02" value="${it.ubicacionActual}"
              oninput="updateItemField(${idx}, 'ubicacionActual', this.value.toUpperCase())" style="text-transform:uppercase;" />
          </div>
        ` : ""}

        <div class="calc-grid">
          <div class="field">
            <label>Cajas por paleta estándar</label>
            <input type="number" inputmode="numeric" placeholder="Ej: 1000" value="${it.cajasPorPaletaStd}"
              oninput="updateItemField(${idx}, 'cajasPorPaletaStd', this.value)" />
          </div>
          <div class="field">
            <label>Cant. paletas estándar</label>
            <input type="number" inputmode="numeric" placeholder="Ej: 4" value="${it.cantPaletasStd}"
              oninput="updateItemField(${idx}, 'cantPaletasStd', this.value)" />
          </div>
        </div>

        ${it.saldos.map((s, sIdx) => `
          <div class="saldo-row">
            <div class="field">
              <label>Cajas en paleta saldo #${sIdx + 1}</label>
              <input type="number" inputmode="numeric" placeholder="Ej: 300" value="${s.cajasPorPaleta}"
                oninput="updateSaldoField(${idx}, ${sIdx}, 'cajasPorPaleta', this.value)" />
            </div>
            <div class="field">
              <label>Cant. paletas saldo</label>
              <input type="number" inputmode="numeric" value="${s.cantPaletas}"
                oninput="updateSaldoField(${idx}, ${sIdx}, 'cantPaletas', this.value)" />
            </div>
            <button type="button" class="btn-danger" onclick="removeSaldoRow(${idx}, ${sIdx})">X</button>
          </div>
        `).join("")}

        <div style="margin-top:8px;">
          <button type="button" class="btn-secondary" style="font-size:0.8rem; padding:6px 10px;" onclick="addSaldoRow(${idx})">+ Agregar Paleta de Saldo</button>
        </div>

        <div class="item-subtotal" id="itemSubtotal_${idx}">
          <span>Paletas: ${calc.totalPaletas}</span>
          <span>Total Cajas: ${calc.totalCajas.toLocaleString()}</span>
        </div>
      </div>
    `;
  }).join("");

  recalculateTripTotals();
}

async function submitDriverTrip() {
  const ordenSalida = document.getElementById("ordenSalidaInput").value.trim();
  const placa = localStorage.getItem(getPlateStorageKey());
  const confirmPaletas = Number(document.getElementById("confirmTotalPaletasInput").value);

  if (!ordenSalida) return alert("Ingresa el N° de Orden de Salida de la guía física.");
  if (!tripBuilderItems.length) return alert("Agrega al menos un material cargado.");

  let grandPaletas = 0;
  const finalItems = [];
  const newUbicacionesToSave = {};

  for (const it of tripBuilderItems) {
    if (it.sinUbicacion) {
      if (!it.ubicacionActual.trim()) {
        return alert(`Debes ingresar la ubicación donde recogiste el material ${it.material}.`);
      }
      newUbicacionesToSave[it.material] = it.ubicacionActual.trim();
    }

    const calc = computeItemTotals(it);
    if (calc.totalPaletas <= 0 || calc.totalCajas <= 0) {
      return alert(`Verifica las cantidades del material ${it.material}.`);
    }

    grandPaletas += calc.totalPaletas;
    finalItems.push({
      programUid: it.programUid,
      material: it.material,
      textoBreve: it.textoBreve,
      orden: it.orden,
      pedido: it.pedido,
      ubicacion: it.ubicacionActual.trim(),
      totalCajas: calc.totalCajas,
      totalPaletas: calc.totalPaletas,
      resumenCalculo: calc.resumenCalculo,
      paletasGloria: null,
      paletasTrupal: null
    });
  }

  if (confirmPaletas !== grandPaletas) {
    return alert(`⚠️ El total de paletas confirmadas (${confirmPaletas}) no coincide con la suma de los materiales (${grandPaletas}). Verifica antes de salir.`);
  }

  try {
    if (Object.keys(newUbicacionesToSave).length > 0) {
      await db.collection("maestros").doc("ubicaciones").set(newUbicacionesToSave, { merge: true });
    }

    await db.collection("viajes").add({
      fechaOperativa: getTodayISO(),
      timestamp: Date.now(),
      conductor: currentUser.name,
      placa: placa,
      ordenSalida: ordenSalida,
      totalPaletasConfirmadas: grandPaletas,
      estadoMontacarga: "PENDIENTE",
      montacarguista: null,
      items: finalItems
    });

    tripBuilderItems = [];
    document.getElementById("ordenSalidaInput").value = "";
    document.getElementById("confirmTotalPaletasInput").value = "";
    renderTripBuilder();
    alert("✅ Viaje registrado en vivo. ¡Buen viaje!");
  } catch (e) {
    alert("Error al guardar viaje: " + e.message);
  }
}

function renderDriverMyTrips() {
  const mine = dailyTrips.filter((t) => t.conductor === currentUser.name);
  const div = document.getElementById("driverMyTripsList");
  if (!mine.length) {
    div.innerHTML = `<p class="subtitle">Aún no has registrado salidas hoy.</p>`;
    return;
  }
  div.innerHTML = mine.map((t) => `
    <div class="trip-card ${t.estadoMontacarga === 'CLASIFICADO' ? 'completed' : 'pending-forklift'}">
      <strong>Orden Salida N° ${t.ordenSalida}</strong> — Total: ${t.totalPaletasConfirmadas} paletas
      <div class="item-meta">Montacarga: ${t.estadoMontacarga === 'CLASIFICADO' ? '✅ Verificado por ' + t.montacarguista : '⏳ Pendiente de clasificar Gloria/Trupal'}</div>
    </div>
  `).join("");
}

// ==========================================
// MÓDULO 3: MONTACARGUISTA (GLORIA VS TRUPAL)
// ==========================================
function renderForkliftTrips() {
  const div = document.getElementById("forkliftTripsList");
  if (!dailyTrips.length) {
    div.innerHTML = `<p class="subtitle">No hay unidades cargadas registradas hoy.</p>`;
    return;
  }

  div.innerHTML = dailyTrips.map((t) => {
    const isDone = t.estadoMontacarga === "CLASIFICADO";
    return `
      <div class="trip-card ${isDone ? 'completed' : 'pending-forklift'}">
        <div class="card-header">
          <div>
            <strong>Orden Salida N° ${t.ordenSalida}</strong> — 🚛 ${t.conductor} (${t.placa})
            <div class="item-meta">Total Unidad: <strong>${t.totalPaletasConfirmadas} paletas</strong></div>
          </div>
          <span class="badge ${isDone ? 'badge-ok' : 'badge-warn'}">${isDone ? '✅ Clasificado' : '⏳ Por Clasificar'}</span>
        </div>

        ${(t.items || []).map((it, idx) => {
          const gVal = it.paletasGloria ?? "";
          const tVal = it.paletasTrupal ?? "";
          return `
            <div class="forklift-mat-row">
              <div><strong>${it.material}</strong> — ${it.textoBreve}</div>
              <div class="item-meta">Total cargado: <strong>${it.totalPaletas} paletas</strong> (${it.totalCajas.toLocaleString()} cajas)</div>
              <div class="quick-btns">
                <button type="button" class="btn-secondary" onclick="setQuickPallets('${t.id}', ${idx}, ${it.totalPaletas}, 0)">Todas Gloria (${it.totalPaletas})</button>
                <button type="button" class="btn-secondary" onclick="setQuickPallets('${t.id}', ${idx}, 0, ${it.totalPaletas})">Todas Trupal (${it.totalPaletas})</button>
              </div>
              <div class="calc-grid">
                <div class="field">
                  <label>Paletas GLORIA</label>
                  <input type="number" inputmode="numeric" id="fk_g_${t.id}_${idx}" value="${gVal}" />
                </div>
                <div class="field">
                  <label>Paletas TRUPAL</label>
                  <input type="number" inputmode="numeric" id="fk_t_${t.id}_${idx}" value="${tVal}" />
                </div>
              </div>
            </div>
          `;
        }).join("")}

        <button type="button" class="btn-primary btn-block" onclick="saveForkliftClassification('${t.id}')">
          Guardar Clasificación de Paletas
        </button>
      </div>
    `;
  }).join("");
}

function setQuickPallets(tripId, itemIdx, gloriaCount, trupalCount) {
  document.getElementById(`fk_g_${tripId}_${itemIdx}`).value = gloriaCount;
  document.getElementById(`fk_t_${tripId}_${itemIdx}`).value = trupalCount;
}

async function saveForkliftClassification(tripId) {
  const trip = dailyTrips.find((t) => t.id === tripId);
  if (!trip) return;

  const updatedItems = [];
  for (let i = 0; i < trip.items.length; i++) {
    const it = trip.items[i];
    const g = Number(document.getElementById(`fk_g_${tripId}_${i}`).value) || 0;
    const tr = Number(document.getElementById(`fk_t_${tripId}_${i}`).value) || 0;

    if (g + tr !== Number(it.totalPaletas)) {
      return alert(`⚠️ Error en ${it.material}: Gloria (${g}) + Trupal (${tr}) suma ${g + tr}, pero el conductor cargó ${it.totalPaletas} paletas.`);
    }

    updatedItems.push({
      ...it,
      paletasGloria: g,
      paletasTrupal: tr
    });
  }

  await db.collection("viajes").doc(tripId).update({
    items: updatedItems,
    estadoMontacarga: "CLASIFICADO",
    montacarguista: currentUser.name
  });

  alert("✅ Clasificación guardada y actualizada en vivo para Auditoría.");
}

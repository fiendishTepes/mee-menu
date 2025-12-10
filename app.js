// ===============================================
// ** 1. CONFIGURATION - IMPORTANT: CHANGE THIS URL **
// ===============================================
// ** เปลี่ยน URL นี้ด้วย Web App URL ที่คุณได้จาก Google Apps Script **
const GOOGLE_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbw8JXXpb2vMke5_qbVvm6yNL85xYe6sQkm-1NFO221daYYAKKLDLL1XuFIq7pRPocITKgQ/exec'; 

// ===============================================
// ** 2. INDEXEDDB SETUP (Persistent Local Storage) **
// ===============================================
const DB_NAME = 'NotesAppDB';
const DB_VERSION = 2; // เพิ่มเวอร์ชันเพื่อรองรับการเปลี่ยนแปลง
const STORE_NAME = 'notes';
// STORE_SYNC_QUEUE ใช้เก็บโน้ตที่ยังไม่ได้ซิงค์
const STORE_SYNC_QUEUE = 'syncQueue'; 

let db;

/**
 * เปิดหรือสร้างฐานข้อมูล IndexedDB
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            // สร้าง Object Store สำหรับโน้ตหลัก
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
            // สร้าง Object Store สำหรับคิวซิงค์ (ใช้ 'id' เดียวกับโน้ตหลัก)
            if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
                db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: 'id' });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('IndexedDB Error:', event.target.errorCode);
            reject(new Error("Failed to open IndexedDB"));
        };
    });
}

/**
 * บันทึกโน้ตลงใน IndexedDB และเพิ่มเข้าคิวซิงค์
 * @param {object} noteData ข้อมูลโน้ต {id, title, content, timestamp}
 */
async function saveNote(noteData) {
    await openDB();

    const noteToSave = { 
        // หากไม่มี ID ให้สร้างขึ้นมา (ต้องเป็นตัวเลข)
        id: noteData.id || Date.now(), 
        title: noteData.title, 
        content: noteData.content, 
        timestamp: noteData.timestamp || new Date().toISOString()
    };

    // บันทึกเข้า Store หลัก (readwrite)
    let transaction = db.transaction([STORE_NAME], 'readwrite');
    let store = transaction.objectStore(STORE_NAME);
    await new Promise((resolve, reject) => {
        const req = store.put(noteToSave);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e);
    });

    // บันทึกเข้าคิวซิงค์ (readwrite)
    transaction = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
    store = transaction.objectStore(STORE_SYNC_QUEUE);
    await new Promise((resolve, reject) => {
        // บันทึกโน้ตลงในคิวซิงค์เพื่อรอการส่งไปยัง Google Sheet
        const req = store.put(noteToSave); 
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e);
    });
    
    return noteToSave;
}

/**
 * ดึงข้อมูลโน้ตทั้งหมดจาก IndexedDB
 * @returns {Promise<Array>} รายการโน้ตทั้งหมด
 */
async function loadAllNotes() {
    await openDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = (event) => {
            const notes = event.target.result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            resolve(notes);
        };
        request.onerror = reject;
    });
}

/**
 * ลบโน้ตตาม ID (จาก Store หลัก)
 * @param {number} id ID ของโน้ตที่จะลบ
 */
async function deleteNote(id) {
    await openDB();

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    return new Promise((resolve, reject) => {
        const request = store.delete(id);
        request.onsuccess = resolve;
        request.onerror = reject;
    });
}

/**
 * ลบคิวซิงค์ตาม ID เมื่อซิงค์สำเร็จ
 * @param {number} id ID ของโน้ตในคิวที่จะลบ
 */
async function clearSyncQueueItem(id) {
    await openDB();
    const transaction = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
    const store = transaction.objectStore(STORE_SYNC_QUEUE);
    
    return new Promise((resolve, reject) => {
        const request = store.delete(id);
        request.onsuccess = resolve;
        request.onerror = reject;
    });
}

/**
 * ดึงรายการโน้ตที่รอการซิงค์ทั้งหมด
 * @returns {Promise<Array>} รายการโน้ตที่ยังไม่ได้ซิงค์
 */
async function getNotesInSyncQueue() {
    await openDB();
    const transaction = db.transaction([STORE_SYNC_QUEUE], 'readonly');
    const store = transaction.objectStore(STORE_SYNC_QUEUE);
    
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = reject;
    });
}


// ===============================================
// ** 3. SYNCHRONIZATION AND NETWORK CHECK **
// ===============================================

const syncButton = document.getElementById('sync-button');
const connectionStatus = document.getElementById('connection-status');

/**
 * ฟังก์ชันดักการเชื่อมต่อ: อัปเดตสถานะและเปิด/ปิดปุ่ม Sync
 */
function updateOnlineStatus() {
    const isOnline = navigator.onLine; // ตรวจสอบสถานะการเชื่อมต่อ
    if (connectionStatus) {
        connectionStatus.textContent = isOnline ? 'Online' : 'Offline';
        connectionStatus.style.color = isOnline ? 'green' : 'red';
    }
    if (syncButton) {
        // ซ่อนปุ่มถ้า Offline เพื่อดักการเชื่อมต่อแล้วระบบไม่ค้าง
        syncButton.style.display = isOnline ? 'block' : 'none'; 
    }
    // หากกลับมา Online ให้ลองซิงค์อัตโนมัติ
    if (isOnline) {
        // รอสักครู่เพื่อให้มั่นใจว่าเครือข่ายพร้อม
        setTimeout(syncDataToSheet, 2000); 
    }
}

/**
 * ส่งข้อมูลโน้ตเดียวไปยัง Google Sheet
 * @param {object} noteData ข้อมูลโน้ต
 */
async function sendNoteToSheet(noteData) {
    if (GOOGLE_SHEET_WEB_APP_URL === 'YOUR_GOOGLE_SHEET_WEB_APP_URL_HERE') {
        throw new Error("GOOGLE_SHEET_WEB_APP_URL is not configured.");
    }
    
    // Google Apps Script ต้องรับข้อมูลผ่าน POST
    const response = await fetch(GOOGLE_SHEET_WEB_APP_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        // ส่งข้อมูลเป็น URL-encoded string (Apps Script ต้องการรูปแบบนี้)
        body: `data=${encodeURIComponent(JSON.stringify(noteData))}`
    });

    if (!response.ok) {
        throw new Error(`Sheet sync failed: ${response.statusText}`);
    }

    // อ่านผลตอบกลับเพื่อยืนยันความสำเร็จ
    return response.json(); 
}

/**
 * ซิงค์ข้อมูลทั้งหมดที่อยู่ในคิวไปยัง Google Sheet
 */
async function syncDataToSheet() {
    if (!navigator.onLine) {
        alert('Cannot sync. You are currently offline.');
        updateOnlineStatus(); // ดักไม่ให้ระบบค้าง
        return;
    }
    
    try {
        syncButton.disabled = true;
        syncButton.textContent = 'Syncing...';
        
        const notesToSync = await getNotesInSyncQueue();
        
        if (notesToSync.length === 0) {
            alert('No new data to sync.');
            return;
        }

        console.log(`Found ${notesToSync.length} notes to sync.`);

        let successCount = 0;
        let failCount = 0;

        for (const note of notesToSync) {
            try {
                // พยายามส่งโน้ตไปยัง Google Sheet
                await sendNoteToSheet(note); 
                // ถ้าสำเร็จ ลบโน้ตออกจากคิวซิงค์
                await clearSyncQueueItem(note.id); 
                successCount++;
                console.log(`Successfully synced and cleared queue for ID: ${note.id}`);
            } catch (error) {
                failCount++;
                console.warn(`Failed to sync ID ${note.id}. Error:`, error);
                // หากซิงค์โน้ตใดล้มเหลว โน้ตนั้นจะยังคงอยู่ในคิวเพื่อซิงค์ในครั้งต่อไป
            }
        }

        alert(`Synchronization complete! Success: ${successCount}, Failed: ${failCount}.`);

    } catch (error) {
        console.error('Overall Sync Error:', error);
        alert('An error occurred during synchronization.');
    } finally {
        syncButton.disabled = false;
        syncButton.textContent = 'Sync Data to Cloud';
    }
}

// ===============================================
// ** 4. UI and Application Logic **
// ===============================================

const notesContainer = document.getElementById('notes-container');
const noteForm = document.getElementById('note-form');
const noteTitleInput = document.getElementById('note-title');
const noteContentInput = document.getElementById('note-content');
let editingNoteId = null; 

/**
 * แสดงโน้ตทั้งหมดบนหน้าจอ
 * @param {Array} notesToRender รายการโน้ต
 */
function renderNotes(notesToRender) {
    if (!notesContainer) return;

    notesContainer.innerHTML = ''; // ล้างโน้ตเก่า

    notesToRender.forEach(note => {
        const noteElement = document.createElement('div');
        noteElement.className = 'note-card';
        noteElement.dataset.id = note.id;

        const formattedDate = new Date(note.timestamp).toLocaleString();

        noteElement.innerHTML = `
            <h3>${note.title || 'Untitled Note'}</h3>
            <p>${note.content.substring(0, 150)}${note.content.length > 150 ? '...' : ''}</p>
            <small>Last updated: ${formattedDate}</small>
            <div class="note-actions">
                <button class="edit-btn" data-id="${note.id}">Edit</button>
                <button class="delete-btn" data-id="${note.id}">Delete</button>
            </div>
        `;
        notesContainer.appendChild(noteElement);
    });

    // กำหนด Event Listener สำหรับปุ่ม Edit และ Delete
    document.querySelectorAll('.delete-btn').forEach(button => {
        button.addEventListener('click', handleNoteDelete);
    });
    document.querySelectorAll('.edit-btn').forEach(button => {
        button.addEventListener('click', handleNoteEdit);
    });
}

/**
 * จัดการการส่งฟอร์มเพื่อบันทึกหรืออัปเดตโน้ต
 * @param {Event} e เหตุการณ์การส่งฟอร์ม
 */
async function handleFormSubmit(e) {
    e.preventDefault();
    const title = noteTitleInput.value.trim();
    const content = noteContentInput.value.trim();

    if (title === '' && content === '') {
        alert('Please enter a title or content for your note.');
        return;
    }

    const newNote = {
        title: title,
        content: content,
        // สำคัญ: ต้องมี ID เพื่อใช้ในการซิงค์และ IndexedDB
        id: editingNoteId !== null ? editingNoteId : Date.now(),
        timestamp: new Date().toISOString()
    };
    
    try {
        await saveNote(newNote); // บันทึกทั้ง IndexedDB และคิวซิงค์
        await initializeApp(); 
        
        // ล้างฟอร์ม
        noteTitleInput.value = '';
        noteContentInput.value = '';
        editingNoteId = null;
        noteForm.querySelector('button[type="submit"]').textContent = 'Add Note';

        // ลองซิงค์ทันทีเมื่อมีการบันทึก (ถ้าออนไลน์)
        if (navigator.onLine) {
            syncDataToSheet();
        }

    } catch (error) {
        alert('Failed to save the note. Data saved locally, will sync later.');
        console.error(error);
    }
}

/**
 * จัดการการลบโน้ต
 * @param {Event} e เหตุการณ์การคลิกปุ่ม
 */
async function handleNoteDelete(e) {
    const id = parseInt(e.target.dataset.id);
    if (confirm('Are you sure you want to delete this note?')) {
        try {
            await deleteNote(id); 
            await clearSyncQueueItem(id); 
            
            await initializeApp();
            // หมายเหตุ: การลบจาก Google Sheet ต้องทำด้วยตนเองในตอนนี้
        } catch (error) {
            alert('Failed to delete the note.');
            console.error(error);
        }
    }
}

/**
 * จัดการการแก้ไขโน้ต
 * @param {Event} e เหตุการณ์การคลิกปุ่ม
 */
async function handleNoteEdit(e) {
    const id = parseInt(e.target.dataset.id);
    const allNotes = await loadAllNotes();
    const noteToEdit = allNotes.find(note => note.id === id);

    if (noteToEdit) {
        noteTitleInput.value = noteToEdit.title;
        noteContentInput.value = noteToEdit.content;
        editingNoteId = noteToEdit.id;
        noteForm.querySelector('button[type="submit"]').textContent = 'Update Note';
        noteForm.scrollIntoView({ behavior: 'smooth' });
    }
}


// ===============================================
// ** 5. INITIALIZATION **
// ===============================================

async function initializeApp() {
    try {
        await openDB();
        const notes = await loadAllNotes();
        renderNotes(notes);
    } catch (error) {
        notesContainer.innerHTML = '<p style="color:red;">Cannot load notes. Local storage might be unavailable.</p>';
        console.error('Initialization Error:', error);
    }

    // กำหนด Event Listeners
    if (noteForm) {
        // ลบ Event Listener เก่าก่อนเพิ่มใหม่เพื่อป้องกันการเรียกซ้ำ
        noteForm.removeEventListener('submit', handleFormSubmit);
        noteForm.addEventListener('submit', handleFormSubmit);
    }
    if (syncButton) {
        syncButton.removeEventListener('click', syncDataToSheet);
        syncButton.addEventListener('click', syncDataToSheet);
    }
    
    // ตั้งค่าการดักการเชื่อมต่อเครือข่าย
    window.removeEventListener('online', updateOnlineStatus);
    window.removeEventListener('offline', updateOnlineStatus);
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus(); // ตรวจสอบสถานะทันทีเมื่อโหลด
}

// เริ่มต้นแอปพลิเคชัน
window.onload = initializeApp;
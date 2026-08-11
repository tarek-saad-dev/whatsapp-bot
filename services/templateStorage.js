const fs = require('fs');
const path = require('path');

function getTemplatesFile() {
    return process.env.DATA_DIR
        ? path.resolve(process.env.DATA_DIR, 'templates.json')
        : path.resolve(__dirname, '..', 'data', 'templates.json');
}

const TEMPLATES_FILE = getTemplatesFile();

const VALID_TYPES = ['sale', 'booking', 'first_time', 'employee_sale', 'employee_advance', 'employee_daily_report'];

const DEFAULT_TEMPLATES = {
    sale: {
        name: 'رسالة البيع',
        template: `أستاذ {{customerName}}
نورت Cut Salon ودايمًا منورنا 🙏✨`,
        updatedAt: new Date().toISOString()
    },
    booking: {
        name: 'رسالة الحجز',
        template: `أهلاً {{customerName}}،

تم تأكيد حجزك في Cut Salon بنجاح ✅

📅 الموعد: {{date}}
🕐 الساعة: {{time}}
💇 الخدمة: {{service}}

منتظرينك! 💈`,
        updatedAt: new Date().toISOString()
    },
    first_time: {
        name: 'رسالة عميل أول مرة',
        template: `أهلاً وسهلاً {{customerName}}! 🎉

نورتنا في Cut Salon لأول مرة وفرحانين إنك اخترتنا.

نتمنى تكون التجربة عجبتك، ولو عندك أي ملاحظة احنا دايمًا هنا.

منتظرينك تاني! 💈`,
        updatedAt: new Date().toISOString()
    },
    employee_sale: {
        name: 'رسالة بيع للموظف',
        template: `أهلاً {{customerName}} 👋

تم تسجيل فاتورة جديدة:
رقم الفاتورة: {{invoiceNumber}}
الخدمات: {{services}}
الفرع: {{branchName}}

بالتوفيق! 💈`,
        updatedAt: new Date().toISOString()
    },
    employee_advance: {
        name: 'رسالة سلفة للموظف',
        template: `أهلاً {{customerName}} 👋

تم تسجيل سلفة جديدة لك:
المبلغ: {{amount}} ج.م
رقم العملية: {{invoiceNumber}}
طريقة الدفع: {{paymentMethod}}
الفرع: {{branchName}}

ملاحظات: {{notes}}

بالتوفيق! 💈`,
        updatedAt: new Date().toISOString()
    },
    employee_daily_report: {
        name: 'تقرير يوم الموظف',
        template: `🌙 تقرير يومك — Cut Salon
{{workDate}}

⏱ الحضور
حضور: {{checkIn}}
انصراف: {{checkOut}}
ساعات: {{actualHours}} من {{scheduledHours}}
الحالة: {{statusLabelAr}}

💰 الأساسي: {{baseWage}} ج.م
{{baseWageNoteAr}}

🎯 التارجت
مبيعات: {{targetSales}} ج.م
مستحق تارجت: {{targetAmount}} ج.م

➖ خصم اليوم: {{deductions}} ج.م
📌 صافي اليوم: {{dayNet}} ج.م

━━━━━━━━━━━━
📒 رصيد حسابك حتى الآن: {{ledgerBalance}} ج.م

لو في أي ملاحظة على اليوم، كلّم الإدارة 🙂`,
        updatedAt: new Date().toISOString()
    }
};

function loadTemplates() {
    const templatesFile = getTemplatesFile();
    try {
        if (fs.existsSync(templatesFile)) {
            const data = fs.readFileSync(templatesFile, 'utf8');
            const parsed = JSON.parse(data);

            // Ensure all valid types exist with defaults
            let changed = false;
            for (const type of VALID_TYPES) {
                if (!parsed[type] || typeof parsed[type].template !== 'string' || parsed[type].template.trim().length === 0) {
                    parsed[type] = DEFAULT_TEMPLATES[type];
                    changed = true;
                }
            }
            if (changed) {
                saveTemplates(parsed);
            }
            return parsed;
        }
    } catch (error) {
        console.error('Error loading templates:', error.message);
    }

    // First run: create defaults
    const templates = { ...DEFAULT_TEMPLATES };
    saveTemplates(templates);
    return templates;
}

function saveTemplates(templates) {
    const templatesFile = getTemplatesFile();
    const dir = path.dirname(templatesFile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(templatesFile, JSON.stringify(templates, null, 2), 'utf8');
}

function getTemplateString(type) {
    const templates = loadTemplates();
    const entry = templates[type];
    return entry ? entry.template : null;
}

module.exports = {
    TEMPLATES_FILE: getTemplatesFile,
    getTemplatesFile,
    VALID_TYPES,
    DEFAULT_TEMPLATES,
    loadTemplates,
    saveTemplates,
    getTemplateString
};

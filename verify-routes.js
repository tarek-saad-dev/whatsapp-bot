/**
 * Quick verification script to check if routes are registered
 * Run: node verify-routes.js
 */

const express = require('express');
const offersRouter = require('./routes/offers');

const app = express();
app.use('/api/offers', offersRouter);

// Get all registered routes
function getRoutes(router, prefix = '') {
    const routes = [];
    
    router.stack.forEach((middleware) => {
        if (middleware.route) {
            // Direct route
            const methods = Object.keys(middleware.route.methods).join(',').toUpperCase();
            routes.push({
                method: methods,
                path: prefix + middleware.route.path,
                handler: middleware.route.stack[0].name || 'anonymous'
            });
        } else if (middleware.name === 'router') {
            // Sub-router
            const subRoutes = getRoutes(middleware.handle, prefix);
            routes.push(...subRoutes);
        }
    });
    
    return routes;
}

console.log('🔍 Checking registered routes in offers router...\n');

const routes = getRoutes(offersRouter, '/api/offers');

console.log('Registered Routes:');
console.log('==================\n');

routes.forEach((route, index) => {
    console.log(`${index + 1}. ${route.method.padEnd(6)} ${route.path}`);
});

console.log('\n');

// Check if summary route exists
const summaryRoute = routes.find(r => r.path.includes('/summary'));
if (summaryRoute) {
    console.log('✅ Summary route found!');
    console.log(`   ${summaryRoute.method} ${summaryRoute.path}`);
    
    // Check if it's before /:id route
    const idRouteIndex = routes.findIndex(r => r.path === '/api/offers/:id' && !r.path.includes('/summary'));
    const summaryRouteIndex = routes.findIndex(r => r.path.includes('/summary'));
    
    if (idRouteIndex !== -1 && summaryRouteIndex !== -1) {
        if (summaryRouteIndex < idRouteIndex) {
            console.log('✅ Summary route is correctly placed BEFORE /:id route');
        } else {
            console.log('⚠️  Summary route is AFTER /:id route - this may cause routing issues!');
        }
    }
} else {
    console.log('❌ Summary route NOT found!');
}

console.log('\n💡 If summary route is missing, check routes/offers.js');
console.log('💡 If server is running, restart it to pick up route changes\n');


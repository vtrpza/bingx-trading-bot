# Render Deployment Troubleshooting Guide

This guide helps troubleshoot common issues when deploying the BingX Trading Bot to Render.

## Changes Made for Render Deployment

### 1. Server Configuration
- **Fixed server binding**: Server now binds to `0.0.0.0:3001` instead of just port 3001
- **Added graceful shutdown**: Proper handling of SIGTERM signals with 25-second timeout
- **Enhanced health check**: Now verifies database connectivity

### 2. Database Configuration
- **Added retry logic**: Handles connection timeouts and transient failures
- **Increased timeouts**: Connection timeout set to 60 seconds for Render's cold starts
- **Enhanced connection pool**: Increased max connections to 10 with proper eviction

### 3. WebSocket Configuration
- **Production-ready setup**: Added origin verification and heartbeat monitoring
- **Better error handling**: Graceful handling of connection failures
- **Render proxy compatibility**: Disabled compression for better proxy compatibility

### 4. Deployment Scripts
- **Sequential execution**: Changed `&&` to `;` in render-start script to ensure migration runs
- **Removed verification step**: Simplified startup to avoid unnecessary failures

### 5. render.yaml Updates
- **Fixed routing**: API routes now preserve full request URI with `$request_uri`
- **Added configuration**: Plan specification, shutdown delay, and instance settings
- **Proper paths**: Changed relative paths to explicit paths (./server, ./client)

## Common Issues and Solutions

### Issue 1: Server Not Responding
**Symptoms**: Health checks fail, 503 errors

**Solutions**:
1. Check server logs for binding errors
2. Verify PORT environment variable is set
3. Ensure server binds to `0.0.0.0`

### Issue 2: Database Connection Failures
**Symptoms**: "Connection refused" or timeout errors

**Solutions**:
1. Verify DATABASE_URL is properly set in Render dashboard
2. Check PostgreSQL addon is provisioned
3. Look for migration errors in logs
4. Ensure SSL is enabled for production

### Issue 3: WebSocket Connection Issues
**Symptoms**: "WebSocket connection failed" in browser console

**Solutions**:
1. Check FRONTEND_URL environment variable matches actual frontend URL
2. Verify WebSocket routes in render.yaml
3. Check for CORS errors in server logs
4. Ensure `/ws` route is properly proxied

### Issue 4: Build Failures
**Symptoms**: "Module not found" or TypeScript errors

**Solutions**:
1. Ensure all dependencies are in package.json (not devDependencies)
2. Check for case-sensitive file imports
3. Verify build output directory exists
4. Check Node.js version compatibility

### Issue 5: Static Site Routing Issues
**Symptoms**: 404 errors on page refresh, API calls failing

**Solutions**:
1. Verify route order in render.yaml (API routes first)
2. Check staticPublishPath is correct (./dist)
3. Ensure SPA fallback route is last
4. Verify API URL in frontend code

## Environment Variables Checklist

Required in Render Dashboard:
- [ ] DATABASE_URL (auto-provided by PostgreSQL addon)
- [ ] BINGX_API_KEY
- [ ] BINGX_SECRET_KEY
- [ ] REDIS_URL (if using Redis)

## Deployment Steps

1. **Push changes to repository**
   ```bash
   git add .
   git commit -m "Fix Render deployment configuration"
   git push origin main
   ```

2. **In Render Dashboard**:
   - Go to your services
   - Check environment variables are set
   - Trigger manual deploy if needed

3. **Monitor deployment**:
   - Watch build logs for errors
   - Check migration output
   - Verify health endpoint responds
   - Test WebSocket connection

4. **Post-deployment verification**:
   - Visit `/health` endpoint
   - Check frontend loads correctly
   - Test API endpoints
   - Verify WebSocket connectivity

## Debug Commands

Run these locally to test:

```bash
# Test production build
cd server
npm run build
npm run start

# Test migration
npm run migrate:render

# Check for TypeScript errors
npx tsc --noEmit
```

## Logs to Check

1. **Build logs**: Look for npm install or compilation errors
2. **Service logs**: Check for startup errors or crashes
3. **Migration output**: Verify database setup completed
4. **Health check failures**: Indicate connectivity issues

## Contact Support

If issues persist after following this guide:
1. Check Render status page
2. Review Render documentation
3. Contact Render support with service logs
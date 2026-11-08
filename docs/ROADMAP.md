# Lộ trình Ghost MCP Secure

Tóm từ README.md, REMOTE.md, SECURITY.md và lịch sử git (kiểm 8/11/2026). Repo không có backlog riêng; việc mới ghi thêm vào bảng dưới.

Cập nhật lần cuối: 8/11/2026 (đưa repo vào Quy chuẩn repo v1 của holdings).

## Trạng thái

| Giai đoạn | Nội dung | Trạng thái |
|---|---|---|
| v2.0 local | MCP server stdio, mô hình quyền opt-in theo cờ env, 7 tool đọc → 42 tool khi mở hết cờ, client Ghost Admin không dependency | ✅ Xong (initial commit `f065610`) |
| Remote | `src/http-server.js`: Streamable HTTP + SSE legacy, OAuth 2.1 + PKCE stateless, landing page, `/healthz`; `Dockerfile` | ✅ Xong (#1) |
| Deploy một lệnh | `deploy/cloud-run.sh` (Secret Manager, pin PUBLIC_URL), `deploy/railway.sh`; nút one-click; `app.json` | ✅ Xong (#2, #3) |
| CD GitHub Actions | `deploy-railway.yml`, `deploy-cloud-run.yml` (WIF keyless), gated bằng biến repo | ✅ Có mã, ⬜ chưa bật (mọi run skipped) |
| Độ bền | Bỏ qua `PUBLIC_URL` sai thay vì hỏng mọi request (#5); upload ảnh retry/timeout/nhận dạng byte (`24776d9`) | ✅ Xong 6/2026 |
| Production Railway | project `superb-smile`, service `ghost-mcp-secure`, `/healthz` 200 ok · 0,2 s | ✅ Đang chạy |
| Quy chuẩn repo v1 | `company.json`, `AGENTS.md`, `tools/health.py`, `docs/ROADMAP.md`, `logs/` | ✅ 8/11/2026 (đợt 5 holdings) |

## Việc tiếp theo (chưa có lịch, cần anh chọn)

| Việc | Ghi chú |
|---|---|
| Xác nhận cách deploy chính thức | Railway nối GitHub auto-deploy hay chỉ `railway up` thủ công; nếu muốn CD thì bật `DEPLOY_RAILWAY` + `RAILWAY_TOKEN` (cần anh duyệt) → cập nhật `deploy.pushDeploys` trong `company.json` |
| Test tự động | Hiện `test` = `node --check`; cân nhắc thêm unit test cho `oauth.js`/`helpers.js` bằng `node:test` (không thêm dependency) và chạy `smoke:remote` trong CI |
| Theo dõi phụ thuộc | `npm run audit` định kỳ; nâng `@modelcontextprotocol/sdk` khi có bản vá bảo mật |
| Cloud Run | Script và workflow có sẵn nhưng chưa dùng; giữ hay bỏ tuỳ nhu cầu |

## Giới hạn đã biết (REMOTE.md "Remote caveats")

- Remote không đọc được đĩa người dùng: upload ảnh/theme dùng `url` hoặc `data_base64`.
- Session MCP/SSE trong bộ nhớ → phải giữ 1 replica (Railway) / `--max-instances 1` (Cloud Run).
- Khuyến nghị giữ `GHOST_ALLOW_DELETE`, `GHOST_ALLOW_SYSTEM` tắt khi chạy online; dùng custom integration riêng để xoay key độc lập.

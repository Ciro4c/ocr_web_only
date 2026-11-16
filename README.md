# OCR Nghị định 30

Chuyển ảnh chụp / file scan văn bản hành chính tiếng Việt thành file Word. Mặc định xuất **văn bản trơn** (chỉ chép nội dung); chọn "Kiểu Word" để dựng thêm **thể thức Nghị định 30/2020/NĐ-CP** (chỉ thể thức, nội dung giữ nguyên). Ảnh chụp được tự tìm tờ giấy và nắn phẳng. Camera hiện "Đã chụp" sau mỗi lần chụp và có nút tắt/bật.
**Chạy hoàn toàn trong trình duyệt, không gửi dữ liệu đi đâu.**

## Bản web (thư mục gốc)
Mở `index.html` qua một máy chủ tĩnh (không mở trực tiếp bằng `file://`), ví dụ `python -m http.server`.
Đưa lên GitHub Pages: *Settings → Pages → Deploy from a branch → `main` / `(root)`*. Mọi thư viện và dữ liệu tiếng Việt đã kèm sẵn nên không cần CDN.

- **Hàng loạt:** chọn / kéo thả nhiều file hoặc cả thư mục, không giới hạn số file và dung lượng (xử lý lần lượt, chọn 1–4 luồng song song), có tiến độ, ước tính thời gian, nút Dừng. Tự cảnh báo khi lô lớn (>100 file hoặc >500 MB), file >40 MB, hoặc bộ nhớ lưu của trình duyệt sắp đầy.
- **Chụp & OCR:** mở camera (điện thoại hoặc máy tính, cần https), chụp là đọc ngay, báo khi ảnh mờ, chụp nhiều trang rồi gộp thành một file Word; có nút dự phòng dùng ứng dụng máy ảnh của máy.
- PDF nhiều trang, chỉnh nghiêng nhẹ, làm trắng nền ảnh chụp.
- Thư viện lưu trong trình duyệt (IndexedDB): tìm, lọc, sửa chữ trước khi xuất, đánh dấu đã kiểm, tải zip Word + `tong_hop.csv`.
- Xuất `.docx`: lề, Times New Roman, cỡ chữ, đầu văn bản 2 cột, quốc hiệu/tiêu ngữ, tên loại + trích yếu, nội dung, nơi nhận, chữ ký, số trang từ trang 2. Chữ OCR kém chắc chắn tô vàng.
- **Chưa có ở bản web:** vẽ lại bảng, giữ hình/con dấu/chữ ký, nắn phẳng ảnh chụp phối cảnh, chế độ biểu mẫu và phiếu trắc nghiệm. Cần các tính năng này hãy dùng bản Python.
- Ảnh phải đủ nét (A4 rộng từ ~1700 px). Luôn rà soát trước khi ban hành.

## Bản Python (`python/`)
Đầy đủ tính năng (bảng, con dấu, chữ ký, biểu mẫu, phiếu trắc nghiệm, thư viện, hàng loạt, bộ cài Windows). Xem `python/README.md`.


## Bộ đọc AI (tự động khi có key)
Tab "⚙ AI": nhập một hoặc nhiều key (Gemini, Groq, OpenRouter — có gói miễn phí; Anthropic — tính phí). Ứng dụng kiểm tra key thật, tự chọn model phù hợp, hết hạn mức thì tự chuyển key/model khác. Không có key hoặc AI lỗi thì dùng Tesseract trong máy. Key chỉ lưu trong trình duyệt; ảnh được gửi tới nhà cung cấp của key.

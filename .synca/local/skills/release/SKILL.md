---
name: release
kind: playbook
description: >
  Use when user asks to cut/publish a release, bump package versions, or runs
  //release. Publish bằng `task publish` trên máy đã đăng nhập npm. Không có
  GitHub Actions. GitHub Release tạo thủ công sau khi npm xác nhận.
---

# Skill: release

Làm theo [DEVELOPER.md](../../../DEVELOPER.md) mục Releasing. npm chỉ phát hành `@ngosangns/ns-bridge`. Đọc bản đang trên npm bằng `npm view @ngosangns/ns-bridge dist-tags versions`, đừng chép số vào đây. Không publish lại version nào đã có trong danh sách đó. Không có workflow GitHub. `task publish` hỏi rồi chạy `npm publish` từ máy đã đăng nhập. Các package provider giữ version cuối và không được bump để publish lại. `gh` luôn kèm `-R ngosangns/ns-bridge`.

Không dùng tag `vX.Y.Z`. Không đẩy tag của package provider. Tag không còn kích hoạt publish. Repo cũ `ns-kiro-provider` không còn là origin.

## Không hỏi đăng nhập npm

`task publish` không chạy `npm login`. Máy phải đăng nhập sẵn. Không xin OTP, không xin token.

## Cắt bản

1. `node scripts/release-plan.mjs`. Chỉ `@ngosangns/ns-bridge` nằm trong plan. Bump `packages/cli/package.json` khi phát hành. Không bump package provider.
2. Commit và push `main`. Pre-commit chạy `task check`.
3. `task publish`. Xác nhận câu hỏi upload. Xác nhận document `https://registry.npmjs.org/<tên>/<version>` trả version đó và `dist-tags.latest` khớp. `npm view` có thể sớm hơn document.
4. `gh release create ns-bridge@<version> -R ngosangns/ns-bridge` sau khi registry xác nhận, nếu người dùng muốn GitHub Release. `--latest` chỉ cho bản người dùng muốn là bản mới nhất. Không ghi provenance.

Version đã có trên npm thì không publish lại.

---
name: release
kind: playbook
description: >
  Use when user asks to cut/publish a release, bump package versions, push a
  version tag, create a GitHub Release, or runs //release. Publish đi qua
  tag-push + GitHub Actions OIDC; GitHub Release tạo thủ công sau khi npm
  xác nhận.
---

# Skill: release

Làm theo [DEVELOPER.md](../../../DEVELOPER.md) mục Releasing. Mỗi package một version. Một tag `<tên-không-scope>@<version>` (ví dụ `ns-kiro-core@0.5.2`) kích hoạt `.github/workflows/publish.yml`. Workflow đăng mọi package public mà version trong `package.json` chưa có trên npm, theo thứ tự phụ thuộc. `gh` luôn kèm `-R ngosangns/ns-bridge`.

Không dùng tag `vX.Y.Z`. Không khóa ba package cùng một version. Repo cũ `ns-kiro-provider` không còn là origin.

## Không hỏi đăng nhập npm

Khi `npm trust list <tên>` đã hiện `repository: ngosangns/ns-bridge`, `file: publish.yml`, và `permissions` có `publish`, package đó phát hành bằng tag. Không chạy `npm login`, không xin OTP, không xin token.

`npm trust list --json` đòi OTP mới. Chỉ dùng `npm trust list`.

Package npm chưa từng thấy thì OIDC không tạo được. Lần đầu: `npm publish` từ máy đã đăng nhập, rồi `npm trust github <tên> --file publish.yml --repo ngosangns/ns-bridge --allow-publish`. Publisher mới hết hạn sau 48 giờ nếu workflow chưa publish thành công một lần. Bản đẩy từ laptop không tính. Bump patch và đẩy tag của package đó trong ngày để CI xác nhận. `workflow_dispatch` dry-run cũng không xác nhận.

## Cắt bản

1. `node scripts/release-plan.mjs`. Package có code đã phát hành thay đổi phải được bump trước package phụ thuộc. Test và markdown không tính là code phát hành.
2. Commit và push `main`.
3. Push đúng một tag của một package nằm trong plan.
4. Chờ workflow trên runner `macmini`. Xác nhận bằng document `https://registry.npmjs.org/<tên>/<version>` trả version đó và `dist-tags.latest` khớp. `npm view` có thể sớm hơn document.
5. `gh release create <tag> -R ngosangns/ns-bridge` sau khi registry xác nhận. `--latest` chỉ cho bản người dùng muốn là bản mới nhất. Không ghi provenance.

Version đã có trên npm thì không publish lại và không đẩy tag lịch sử của version đó.

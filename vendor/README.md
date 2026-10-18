# 同梱ライブラリ（オフライン動作のため）

| ファイル | ライブラリ | バージョン | ライセンス |
|---|---|---|---|
| matter.min.js | Matter.js（物理エンジン） | 0.20.0 | MIT（matter-js.LICENSE） |
| decomp.min.js | poly-decomp（凹多角形の分割） | 0.3.0 | MIT（poly-decomp.LICENSE） |
| mediapipe/vision_bundle.mjs, mediapipe/wasm/* | MediaPipe Tasks Vision | 0.10.14 | Apache-2.0 |
| mediapipe/face_landmarker.task | MediaPipe Face Landmarker モデル（float16 v1） | 1 | Apache-2.0 |
| mediapipe/selfie_multiclass.tflite | MediaPipe Selfie Multiclass Segmentation（256x256, float32）髪・顔の肌などを塗り分け | latest (2026-10 取得) | Apache-2.0 |
| mediapipe/magic_touch.tflite | MediaPipe Interactive Segmenter（MagicTouch）タップした物を切り抜き | latest (2026-10 取得) | Apache-2.0 |

MediaPipe は SIMD 版の wasm のみ同梱（現行の主要ブラウザはすべて対応）。

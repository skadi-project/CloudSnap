        import { captureFirstFrame as captureFirstFrameBytes } from '../../tools/first-frame.js';

        const video = document.getElementById('captureVideo');
        const cropCanvas = document.getElementById('cropCanvas');
        const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: false });

        // Состояние записи
        let isPaused = false;
        let lastFrameData = null;
        let cropRect = null;
        let cropLoopRunning = false;
        let sessionId = null;
        // t0 — единая точка отсчёта задержки, приходит из main через IPC.
        // Раньше пытались использовать globalThis._recordingT0, но из-за
        // contextIsolation значение из main в renderer не попадало.
        let recordingT0 = 0;
        let stopRequested = false;
        let finished = false;
        let frameCount = 0;

        // JPEG-байты первого отрисованного кадра. Используется:
        //  • в setupWebCodecsEncoder — как встроенный cover art MP4 (видно в
        //    «Крупные значки» Проводника Windows);
        //  • в doFinish — отправляется в main для миниатюры истории
        //    и sidecar cover.jpg (для WebM-fallback, где cover art не встроить).
        let firstFrameJpeg = null;       // Uint8Array | null
        let firstFrameJpegBase64 = null; // string | null
        let firstFrameSent = false;

        // Потоки
        let captureStream = null;     // getUserMedia поток (видео + аудио с desktop)
        let videoStreamTrack = null;  // MediaStreamTrack видео
        let audioStreamTrack = null;  // MediaStreamTrack аудио (отдельный!)

        // WebCodecs + Mediabunny
        let mediabunny = null;
        let muxerOutput = null;
        let videoEncoder = null;
        let audioEncoder = null;
        let videoSource = null;
        let audioSource = null;
        let useWebCodecs = false;
        let audioContext = null;
        let audioWorkletNode = null;

        // Fallback MediaRecorder
        let mediaRecorder = null;
        let fallbackStream = null;
        let pendingChunks = 0;
        const recordedChunks = [];

        // === Загрузка Mediabunny ===
        async function loadMediabunny() {
            // Mediabunny экспортируется как ESM. В Electron renderer процесс
            // работает с nodeIntegration:false, поэтому грузим через dynamic import.
            try {
                const mod = await import('mediabunny');
                return mod;
            } catch (e) {
                console.error('[recorder] Failed to load mediabunny:', e);
                return null;
            }
        }

        // Сохраняет JPEG-байты первого кадра. Вызывается ПОСЛЕ video.play(),
        // но ДО setupWebCodecsEncoder, чтобы cover art был готов к моменту
        // muxerOutput.start() (setMetadataTags требует состояние 'pending').
        // Также сохраняем base64-копию — она нужна для sendRecordingThumbnail,
        // а исходный Uint8Array понадобится mediabunny в cover art.
        //
        // Реализация вынесена в src/tools/first-frame.js (Фаза 2.3).
        function captureFirstFrame() {
            const { jpegBytes, jpegBase64 } = captureFirstFrameBytes(cropCanvas);
            firstFrameJpeg = jpegBytes;
            firstFrameJpegBase64 = jpegBase64;
            if (jpegBytes && jpegBase64) {
                console.log('[recorder] first frame captured:',
                    cropCanvas.width + 'x' + cropCanvas.height,
                    'jpeg bytes:', jpegBytes.length,
                    'base64 chars:', jpegBase64.length);
            }
        }

        function checkWebCodecsSupport() {
            return typeof window.VideoEncoder !== 'undefined' &&
                   typeof window.VideoFrame !== 'undefined' &&
                   typeof window.AudioEncoder !== 'undefined' &&
                   typeof window.AudioData !== 'undefined';
        }

        function selectH264Codec(bitrate) {
            // Пробуем разные профили H.264 — от самого совместимого к менее
            const candidates = [
                'avc1.42E01F', // Baseline 3.1
                'avc1.42E01E', // Baseline 3.0
                'avc1.42001F', // Baseline 3.1 (alt)
                'avc1.640028', // High 4.0
            ];
            for (const codec of candidates) {
                try {
                    const support = VideoEncoder.isConfigSupported({
                        codec,
                        width: cropCanvas.width,
                        height: cropCanvas.height,
                        bitrate,
                        framerate: 30
                    });
                    // isConfigSupported возвращает Promise
                    // Проверим синхронно через конструктор
                    const test = new VideoEncoder({ output: () => {}, error: () => {} });
                    test.configure({ codec, width: 100, height: 100, bitrate: 100000, framerate: 30 });
                    test.close();
                    return codec;
                } catch (e) {
                    continue;
                }
            }
            return null;
        }

        async function setupWebCodecsEncoder(config) {
            const { bitrate, fps, audio } = config;
            const width = cropRect ? cropRect.w : video.videoWidth;
            const height = cropRect ? cropRect.h : video.videoHeight;
            console.log('[recorder][webcodecs] video stream:', video.videoWidth + 'x' + video.videoHeight,
                'cropRect:', cropRect ? JSON.stringify({x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h}) : 'null',
                '→ canvas:', width + 'x' + height);
            console.log('[bitrate] webcodecs path → VideoEncoder bitrate =', bitrate,
                `(${(bitrate / 1_000_000).toFixed(2)} Мбит/с)`, 'fps=', fps);

            // Выбираем H.264 codec
            const videoCodec = selectH264Codec(bitrate);
            if (!videoCodec) {
                throw new Error('No supported H.264 codec found');
            }
            console.log('[recorder] Using video codec:', videoCodec);

            // === Mediabunny MP4 muxer ===
            // Output с target: 'buffer' накапливает MP4 в памяти,
            // на stop мы нарежем его на чанки и пошлём через IPC.
            muxerOutput = new mediabunny.Output({
                format: new mediabunny.Mp4OutputFormat({ fastStart: 'in-memory' }),
                target: 'buffer'
            });

            // === Cover art для Проводника Windows ===
            // Встраиваем JPEG первого кадра как «coverFront» в MP4-контейнер.
            // Windows Explorer читает этот атом и показывает картинку
            // в режимах «Крупные значки» / «Огромные значки» без перекодирования.
            // Mediabunny пишет его в стандартный iTunes-style «covr» atom.
            if (firstFrameJpeg) {
                muxerOutput.setMetadataTags({
                    images: [{
                        data: firstFrameJpeg,
                        mimeType: 'image/jpeg',
                        kind: 'coverFront'
                    }]
                });
                console.log('[recorder] cover art set, jpeg bytes:', firstFrameJpeg.length);
            }

            // === Video source (CanvasSource рисует с canvas) ===
            videoSource = new mediabunny.CanvasSource(cropCanvas, {
                codec: 'avc',
                bitrate,
                keyFrameInterval: 2,
                frameRate: fps
            });
            muxerOutput.addVideoTrack(videoSource, { codec: videoCodec });

            // === Audio source ===
            if (audio && audioStreamTrack) {
                // AAC-LC для MP4
                let audioCodec = 'mp4a.40.2';
                try {
                    const testEnc = new AudioEncoder({ output: () => {}, error: () => {} });
                    testEnc.configure({ codec: audioCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
                    testEnc.close();
                } catch (e) {
                    console.warn('[recorder] AAC not supported, trying opus');
                    audioCodec = 'opus';
                }
                console.log('[recorder] Using audio codec:', audioCodec);

                audioSource = new mediabunny.MediaStreamAudioTrackSource(audioStreamTrack, {
                    codec: audioCodec === 'mp4a.40.2' ? 'aac' : 'opus',
                    bitrate: 128000
                });
                muxerOutput.addAudioTrack(audioSource);
            }

            await muxerOutput.start();
            console.log('[recorder] Mediabunny MP4 muxer started');
        }

        function sendMp4Chunk(uint8Array) {
            // Отправляем в main process. Контекст изолирован, поэтому
            // передаём копию Uint8Array через IPC structured clone.
            window.electronAPI.sendRecordingChunk(new Uint8Array(uint8Array), sessionId);
        }

        async function finalizeMuxer() {
            if (!muxerOutput) return;
            try {
                await videoSource.close?.();
                if (audioSource) await audioSource.close?.();
                await muxerOutput.finalize();
                const buffer = muxerOutput.target.buffer;
                if (buffer && buffer.byteLength > 0) {
                    console.log('[recorder] MP4 finalized, size:', buffer.byteLength);
                    // Стримим MP4 чанками по 1 МБ в main process
                    const CHUNK = 1024 * 1024;
                    const u8 = new Uint8Array(buffer);
                    for (let i = 0; i < u8.length; i += CHUNK) {
                        const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length));
                        sendMp4Chunk(slice);
                    }
                }
            } catch (e) {
                console.error('[recorder] Failed to finalize muxer:', e);
            } finally {
                muxerOutput = null;
                videoSource = null;
                audioSource = null;
            }
        }

        async function setupMediaRecorderFallback(config) {
            // Fallback: используем старый MediaRecorder для WebM.
            // Применяется, если WebCodecs/Mediabunny недоступны.
            console.log('[recorder] Using MediaRecorder fallback (webm)');
            console.log('[recorder][fallback] cropCanvas size:', cropCanvas.width + 'x' + cropCanvas.height,
                'cropRect:', cropRect ? JSON.stringify({x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h}) : 'null');
            let mimeType = 'video/webm;codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp9';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

            const options = { mimeType };
            if (config.bitrate) options.videoBitsPerSecond = config.bitrate;
            console.log('[bitrate] fallback path → MediaRecorder videoBitsPerSecond =', options.videoBitsPerSecond,
                `(${((options.videoBitsPerSecond || 0) / 1_000_000).toFixed(2)} Мбит/с)`);

            // КРИТИЧНО: захватываем ПОТОК CROP_CANVAS (содержит вырезанную область),
            // а НЕ полный videoStreamTrack (иначе запишется весь экран).
            // Старый код использовал cropCanvas.captureStream() — это правильный подход.
            if (!cropRect) {
                console.warn('[recorder][fallback] no cropRect — recording full screen is expected');
            }
            fallbackStream = cropCanvas.captureStream(config.fps || 30);
            if (config.audio && audioStreamTrack) {
                fallbackStream.addTrack(audioStreamTrack);
            }
            console.log('[recorder][fallback] fallback stream tracks:', fallbackStream.getTracks().length,
                'video:', fallbackStream.getVideoTracks().length,
                'audio:', fallbackStream.getAudioTracks().length);

            mediaRecorder = new MediaRecorder(fallbackStream, options);
            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    pendingChunks++;
                    e.data.arrayBuffer().then(buf => {
                        window.electronAPI.sendRecordingChunk(new Uint8Array(buf), sessionId);
                        pendingChunks--;
                        checkFinished();
                    });
                }
            };
            mediaRecorder.onstop = () => { checkFinished(); };
            mediaRecorder.onerror = (e) => { console.error('MediaRecorder error:', e); doFinish(); };
            mediaRecorder.start(500); // 500ms timeslice — быстрее обнаруживаем stop
        }

        function checkFinished() {
            if (useWebCodecs) {
                // Для WebCodecs финализация явная в doFinish
                if (stopRequested && !finished) doFinish();
            } else {
                if (stopRequested && pendingChunks === 0 && !finished) doFinish();
            }
        }

        async function doFinish() {
            if (finished) return;
            finished = true;
            cropLoopRunning = false;

            // Останавливаем треки
            if (videoStreamTrack) { videoStreamTrack.stop(); videoStreamTrack = null; }
            if (audioStreamTrack) { audioStreamTrack.stop(); audioStreamTrack = null; }
            captureStream = null;

            if (useWebCodecs) {
                // WebCodecs + Mediabunny финализация
                await finalizeMuxer();
            } else if (mediaRecorder) {
                // MediaRecorder fallback
                if (mediaRecorder.state !== 'inactive') {
                    try { mediaRecorder.stop(); } catch (e) {}
                }
                if (fallbackStream) {
                    fallbackStream.getTracks().forEach(t => t.stop());
                    fallbackStream = null;
                }
                mediaRecorder = null;
                // Ждём последние chunks
                await new Promise(r => setTimeout(r, 200));
            }

            // Миниатюра: используем ПЕРВЫЙ кадр, а не последний.
            // Первый кадр стабильнее (последний может быть пустым/артефактным
            // при резкой остановке) и одинаково подходит и для cover art MP4,
            // и для sidecar cover.jpg, и для иконки в истории.
            // Байты firstFrameJpeg были получены в captureFirstFrame() ещё до
            // старта cropLoop и сохранены вместе с base64-копией.
            try {
                if (firstFrameJpegBase64 && window.electronAPI.sendRecordingThumbnail) {
                    window.electronAPI.sendRecordingThumbnail(firstFrameJpegBase64);
                    firstFrameSent = true;
                    console.log('[recorder] thumbnail sent (first frame), base64 chars:',
                        firstFrameJpegBase64.length,
                        'jpeg bytes:', firstFrameJpeg ? firstFrameJpeg.length : 0);
                } else if (frameCount > 0 && cropCanvas.width > 0 && cropCanvas.height > 0) {
                    // Fallback на последний кадр, если firstFrame почему-то не снят
                    // (например, video.play() не успел дать кадр до setup).
                    const dataUrl = cropCanvas.toDataURL('image/jpeg', 0.6);
                    const base64 = dataUrl.split(',')[1];
                    if (base64) {
                        window.electronAPI.sendRecordingThumbnail(base64);
                        firstFrameSent = true;
                        console.warn('[recorder] first frame not captured, fallback to last frame');
                    }
                } else {
                    console.warn('[recorder] skip thumbnail: no frames drawn yet');
                }
            } catch (e) {
                console.warn('[recorder] Failed to capture thumbnail:', e);
            }

            window.electronAPI.sendRecordingFinished();
        }

        window.electronAPI.onInitRecording(async (config) => {
            sessionId = config.sessionId;
            recordingT0 = config.t0 || Date.now();
            stopRequested = false;
            finished = false;
            isPaused = false;
            lastFrameData = null;
            cropLoopRunning = false;
            frameCount = 0;
            firstFrameJpeg = null;
            firstFrameJpegBase64 = null;
            firstFrameSent = false;

            try {
                // === Шаг 1: захват экрана через desktopCapturer (Electron) ===
                const videoConstraints = {
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: config.sourceId
                        }
                    }
                };
                if (config.audio) {
                    videoConstraints.audio = {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: config.sourceId
                        }
                    };
                }

                captureStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
                videoStreamTrack = captureStream.getVideoTracks()[0] || null;
                audioStreamTrack = captureStream.getAudioTracks()[0] || null;

                // КРИТИЧНО: НЕ добавляем audio track в поток, который потом стопаем
                // иначе потеряем звук. Каждый track управляется отдельно.
                video.srcObject = new MediaStream([videoStreamTrack]);
                await video.play();

                cropRect = config.cropRect;
                if (cropRect) {
                    cropCanvas.width = cropRect.w;
                    cropCanvas.height = cropRect.h;
                } else {
                    // fullscreen: используем размеры потока
                    const settings = videoStreamTrack.getSettings();
                    cropCanvas.width = settings.width || 1920;
                    cropCanvas.height = settings.height || 1080;
                }

                // === Захват первого кадра для cover art и миниатюры истории ===
                // Сначала рисуем кадр в cropCanvas (всё равно это сделает
                // cropDraw ниже), затем кодируем в JPEG. Делаем это ДО
                // setupWebCodecsEncoder, чтобы firstFrameJpeg был готов к
                // моменту muxerOutput.start().
                // Ждём один кадр через rAF, чтобы video точно дал кадр после play().
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                if (cropRect) {
                    cropCtx.drawImage(video,
                        cropRect.x, cropRect.y, cropRect.w, cropRect.h,
                        0, 0, cropCanvas.width, cropCanvas.height);
                } else {
                    cropCtx.drawImage(video, 0, 0, cropCanvas.width, cropCanvas.height);
                }
                captureFirstFrame();

                // === Шаг 2: выбираем кодек (WebCodecs или fallback) ===
                useWebCodecs = checkWebCodecsSupport();
                if (useWebCodecs) {
                    mediabunny = await loadMediabunny();
                    if (!mediabunny) useWebCodecs = false;
                }

                if (useWebCodecs) {
                    await setupWebCodecsEncoder(config);
                } else {
                    await setupMediaRecorderFallback(config);
                }

                // === Шаг 3: crop loop — рисуем кадры в cropCanvas ===
                cropLoopRunning = true;
                function cropDraw() {
                    if (!cropLoopRunning) return;
                    if (!isPaused) {
                        try {
                            if (cropRect) {
                                cropCtx.drawImage(video,
                                    cropRect.x, cropRect.y, cropRect.w, cropRect.h,
                                    0, 0, cropCanvas.width, cropCanvas.height
                                );
                            } else {
                                cropCtx.drawImage(video, 0, 0, cropCanvas.width, cropCanvas.height);
                            }
                            lastFrameData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);

                            // Для WebCodecs: Mediabunny CanvasSource сам забирает
                            // кадры с canvas через add(). Это вызывается ниже.
                            if (useWebCodecs && videoSource) {
                                // canvas.timestampMs — дельта в мс с начала записи
                                videoSource.add((frameCount * 1000) / (config.fps || 30));
                            }
                            // Сообщаем в main о первом кадре — для отладочного лога общей задержки
                            if (frameCount === 0) {
                                console.log('[recorder] First frame drawn: canvas',
                                    cropCanvas.width + 'x' + cropCanvas.height,
                                    'video.srcObject: video track',
                                    'path:', useWebCodecs ? 'webcodecs' : 'fallback');
                                if (window.electronAPI.sendRecordingFirstFrame) {
                                    window.electronAPI.sendRecordingFirstFrame(Date.now());
                                }
                            }
                            frameCount++;
                        } catch (e) {
                            console.error('[recorder] cropDraw error:', e);
                        }
                    } else if (lastFrameData) {
                        cropCtx.putImageData(lastFrameData, 0, 0);
                        if (useWebCodecs && videoSource) {
                            videoSource.add((frameCount * 1000) / (config.fps || 30));
                            frameCount++;
                        }
                    }
                    requestAnimationFrame(cropDraw);
                }
                cropDraw();

            } catch (err) {
                console.error('Failed to start recording:', err);
                if (videoStreamTrack) { videoStreamTrack.stop(); videoStreamTrack = null; }
                if (audioStreamTrack) { audioStreamTrack.stop(); audioStreamTrack = null; }
                captureStream = null;
                window.electronAPI.sendRecordingFinished();
            }
        });

        window.electronAPI.onPauseRecording(() => {
            isPaused = true;
            if (!useWebCodecs && mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.pause();
            }
        });

        window.electronAPI.onResumeRecording(() => {
            isPaused = false;
            if (!useWebCodecs && mediaRecorder && mediaRecorder.state === 'paused') {
                mediaRecorder.resume();
            }
        });

        window.electronAPI.onStopRecording(() => {
            stopRequested = true;
            if (useWebCodecs) {
                // cropLoop остановится в doFinish
                checkFinished();
            } else {
                if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
                    mediaRecorder.stop();
                }
                checkFinished();
            }
        });

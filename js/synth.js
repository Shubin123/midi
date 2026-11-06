
            const AudioContextGlobal = window.AudioContext || window.webkitAudioContext;
            let audioContext;
            let masterGain, filterNode, filterBypassGain, masterLimiter, analyser;
            const oscTaps = []; // Per-oscillator sums for the oscilloscope: { sum, analyser }, made as they are needed
            let fxInput, fxOutput; // Insert point for effect and plugin widgets
            let voiceBus; // Built-in synth voices only; plug-in instruments mute it unless layered
            let visualizerCanvas, visualizerContext;

            const activeSoundUnits = {}; // For live played notes
            const releasingUnits = new Set(); // Notes let go and fading out, which a panic cuts short too
            const activeComputerKeys = new Set();
            const activeTouches = new Map();
            let isMouseDraggingOnKeyboard = false;
            let currentDraggedKeyElement = null;

            const keyMapping = {'a':0,'w':1,'s':2,'e':3,'d':4,'f':5,'t':6,'g':7,'y':8,'h':9,'u':10,'j':11,'k':12,'o':13,'l':14,'p':15,';':16,'\'':17};
            const keyReverseLookup = {}; Object.keys(keyMapping).forEach(k => keyReverseLookup[keyMapping[k]] = k);

            // The oscillators themselves are the bank in js/oscillators.js (window.oscillatorBank).
            let baseOctaveSelect, oscSlopInput,
                enableAdsrToggle, attackInput, decayInput, sustainInput, releaseInput, adsrControls,
                enableFilterToggle, filterTypeSelect, filterCutoffInput, filterResonanceInput, filterControlsElement,
                masterVolumeInput, numOctavesSelect, visualizerSourceSelect,
                keyboardContainer, uiThemeSelect, uiScaleInput,
                synthesiaToggle, synthesiaContainer, stopAllSoundsButton,
                toggleLooperButton; // Added for looper toggle
            let whiteNoiseBuffer;

            const keysPattern = [{type:'white',note:'C'},{type:'black',note:'C#'},{type:'white',note:'D'},{type:'black',note:'D#'},{type:'white',note:'E'},{type:'white',note:'F'},{type:'black',note:'F#'},{type:'white',note:'G'},{type:'black',note:'G#'},{type:'white',note:'A'},{type:'black',note:'A#'},{type:'white',note:'B'}];
            const midiNoteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
            const WHITE_KEYS_PER_OCTAVE = 7;
            // The theme table and how themes and the UI scale are applied (early, before the page draws): js/themes.js.
            function applyTheme(themeName) { window.uiThemes.applyTheme(themeName); }
            function applyUIScale(scalePercent) { window.uiThemes.applyScale(scalePercent); resizeCanvas(); }

            let activeVisualNoteElements = [];
            const FALL_SPEED_PIXELS_PER_SECOND = 100; 
            const NOTE_TAIL_DURATION_MS_VISUAL = 2500; 
            const MIN_FALLING_NOTE_HEIGHT = 10; 
            const BURST_ANIMATION_DURATION = 300; // ms, should match CSS

            // Looper state
            const NUM_LOOP_SLOTS = 4;
            let loopSlotsData = [];
            let currentArmedSlotId = -1; 
            let looperQuantizationTimeout = null;
            let launchpadLooperContainer;


            let metronomeEnabled = false, currentBPM = 120, metronomeIntervalId = null, metronomeClickBuffer, metronomeToggle, bpmDisplay, bpmIncrement, bpmDecrement, tapTempoButton, metronomeLed;
            const MIN_BPM = 30, MAX_BPM = 300, tapTempoTimes = []; let tapTempoLastTap; const MAX_TAP_INTERVAL = 3000;
            let sustainPedalActive = false, notesSustained = new Set();


            function createNoiseBuffers() { if (!audioContext) return; const bS = audioContext.sampleRate * 2; whiteNoiseBuffer = audioContext.createBuffer(1, bS, audioContext.sampleRate); const o = whiteNoiseBuffer.getChannelData(0); for (let i=0; i<bS; i++) o[i] = Math.random()*2-1;}
            function createMetronomeClickBuffer() { if (!audioContext) return; const d=0.025, sR=audioContext.sampleRate, fC=Math.floor(sR*d); metronomeClickBuffer=audioContext.createBuffer(1,fC,sR); const data=metronomeClickBuffer.getChannelData(0); data[0]=0.8; data[1]=-0.8; for(let i=2;i<fC;i++)data[i]=(Math.random()*0.2-0.1)*(1-i/fC);}

            function initAudio() {
                if(audioContext) return;
                audioContext = new AudioContextGlobal();
                createNoiseBuffers(); createMetronomeClickBuffer();

                masterGain = audioContext.createGain();
                masterGain.gain.value = parseFloat(masterVolumeInput.value);

                filterNode = audioContext.createBiquadFilter();
                filterBypassGain = audioContext.createGain(); 
                
                masterLimiter = audioContext.createDynamicsCompressor();
                masterLimiter.threshold.setValueAtTime(-3, audioContext.currentTime); 
                masterLimiter.knee.setValueAtTime(0, audioContext.currentTime);      
                masterLimiter.ratio.setValueAtTime(20, audioContext.currentTime);    
                masterLimiter.attack.setValueAtTime(0.003, audioContext.currentTime); 
                masterLimiter.release.setValueAtTime(0.1, audioContext.currentTime); 

                voiceBus = audioContext.createGain();
                filterNode.connect(voiceBus);
                filterBypassGain.connect(voiceBus);
                voiceBus.connect(masterGain);
                fxInput = audioContext.createGain(); fxOutput = audioContext.createGain();
                masterGain.connect(fxInput); fxInput.connect(fxOutput); fxOutput.connect(masterLimiter);


                analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;

                masterLimiter.connect(analyser); 
                analyser.connect(audioContext.destination);

                visualizerCanvas = document.getElementById('visualizerCanvas');
                visualizerContext = visualizerCanvas.getContext('2d');
                resizeCanvas();
                visualize();
                setupMIDI();
                if (synthesiaToggle.checked) createSynthesiaGrid();
            }
            
            function getCurrentSynthParams() {
                return {
                    oscillators: window.oscillatorBank.list(),
                    common: {
                        oscSlop: parseFloat(oscSlopInput.value),
                    },
                    adsr: {
                        enabled: enableAdsrToggle.checked,
                        attack: parseFloat(attackInput.value),
                        decay: parseFloat(decayInput.value),
                        sustain: parseFloat(sustainInput.value),
                        release: parseFloat(releaseInput.value)
                    },
                    filter: {
                        enabled: enableFilterToggle.checked,
                        type: filterTypeSelect.value,
                        cutoff: parseFloat(filterCutoffInput.value),
                        resonance: parseFloat(filterResonanceInput.value)
                    }
                };
            }


            function createKeyboard() { keyboardContainer.innerHTML = ''; let computerKeyIndex = 0; let whiteKeyCounter = 0; const baseOctave = parseInt(baseOctaveSelect.value); const numOctaves = parseInt(numOctavesSelect.value); const totalWhiteKeys = WHITE_KEYS_PER_OCTAVE * numOctaves + 1; /* the octaves plus a closing C: two octaves are 25 keys, like a 25-key controller */ for (let o = 0; o <= numOctaves; ++o) { keysPattern.forEach((keyData, patternIndex) => { if (o === numOctaves && patternIndex > 0) return; const currentOctave = baseOctave + o; const noteWithOctave = `${keyData.note}${currentOctave}`; const midiValue = (currentOctave * 12) + patternIndex; const keyElement = document.createElement('div'); keyElement.dataset.note = noteWithOctave; keyElement.dataset.midi = midiValue; keyElement.dataset.keymapIndex = computerKeyIndex; keyElement.dataset.isBlack = keyData.type === 'black'; if (keyData.type === 'white') { keyElement.className = 'white-key'; keyElement.style.flexBasis = `calc(100% / ${totalWhiteKeys})`; if (keyReverseLookup[computerKeyIndex] && o < 2) { const keyLabel = document.createElement('div'); keyLabel.className = 'key-label'; keyLabel.textContent = keyReverseLookup[computerKeyIndex].toUpperCase(); keyElement.appendChild(keyLabel); } keyboardContainer.appendChild(keyElement); whiteKeyCounter++; } else { keyElement.className = 'black-key'; /* centred on the gap between its two white keys, inside the keyboard's padding (where the white keys sit) */ const gap = whiteKeyCounter / totalWhiteKeys, blackWidth = 0.6 / totalWhiteKeys; keyElement.style.left = `calc(var(--kb-pad) + (100% - 2 * var(--kb-pad)) * ${gap - blackWidth / 2})`; keyElement.style.width = `calc((100% - 2 * var(--kb-pad)) * ${blackWidth})`; if (keyReverseLookup[computerKeyIndex] && o < 2) { const keyLabel = document.createElement('div'); keyLabel.className = 'key-label'; keyLabel.textContent = keyReverseLookup[computerKeyIndex].toUpperCase(); keyElement.appendChild(keyLabel); } keyboardContainer.appendChild(keyElement); } computerKeyIndex++; }); } if (synthesiaContainer?.classList.contains('active')) requestAnimationFrame(createSynthesiaGrid); }
            function noteToFrequency(note, octaveOffset = 0){const nN=note.replace(/\d+$/,'');const bO=parseInt(note.match(/\d+$/)[0]);const tO=bO+octaveOffset;const nI=midiNoteNames.indexOf(nN);const cA4M=69;const cMN=(tO*12)+nI;return 440*Math.pow(2,(cMN-cA4M)/12);}
            function midiNoteToNoteString(mN){const o=Math.floor(mN/12),nI=mN%12;return midiNoteNames[nI]+o;}
            // The oscilloscope's tap for oscillator i: a sum of that oscillator across every live note.
            function oscTap(i) { if (!oscTaps[i]) { const sum = audioContext.createGain(), an = audioContext.createAnalyser(); an.fftSize = 2048; sum.connect(an); oscTaps[i] = { sum, analyser: an }; } return oscTaps[i]; }

            function playNote(noteString, velocity = 0.7, source = "unknown", forceRetrigger = false, synthParamsOverride = null) {
                if (!audioContext) initAudio();
                if (!audioContext) { console.warn("Audio context not available for playNote."); return null; }

                const params = synthParamsOverride || getCurrentSynthParams();
                const slotId = source.startsWith('looper-slot-') ? parseInt(source.split('-')[2]) : -1;

                if (slotId === -1 && currentArmedSlotId !== -1 && loopSlotsData[currentArmedSlotId].isRecording) {
                    recordEvent(currentArmedSlotId, 'noteon', noteString, velocity, params);
                }
                
                const now = audioContext.currentTime;
                if (slotId !== -1 || !activeSoundUnits[noteString] || forceRetrigger) emitNote(noteString, velocity, true, source);

                if (slotId === -1) { 
                    if (activeSoundUnits[noteString] && !forceRetrigger) { 
                        if (sustainPedalActive) notesSustained.add(noteString); 
                        return null; 
                    }
                    if (activeSoundUnits[noteString] && forceRetrigger) { 
                        const oU = activeSoundUnits[noteString]; 
                        oU.mainNoteGain.gain.cancelScheduledValues(now); 
                        let cOGV=0; try{cOGV=oU.mainNoteGain.gain.value;}catch(e){} 
                        oU.mainNoteGain.gain.setValueAtTime(Math.max(cOGV,0.00001),now); 
                        oU.mainNoteGain.gain.exponentialRampToValueAtTime(0.0001,now+0.02); 
                        const qST=now+0.02+0.05; 
                        oU.oscillators.forEach(o=>{try{o.stop(qST);}catch(e){}}); 
                        setTimeout(()=>{
                            if(oU.mainNoteGain)oU.mainNoteGain.disconnect(); 
                            oU.layers.forEach(l => l.nodes.forEach(n => n.disconnect()));
                        }, (0.02+0.05+0.01)*1000); 
                        delete activeSoundUnits[noteString];
                    }
                }

                const unit = { mainNoteGain: audioContext.createGain(), oscillators: [], source: source };
                
                if (slotId !== -1) { 
                    if (!loopSlotsData[slotId].soundUnits[noteString]) {
                        loopSlotsData[slotId].soundUnits[noteString] = [];
                    }
                    loopSlotsData[slotId].soundUnits[noteString].push(unit);
                } else { 
                    activeSoundUnits[noteString] = unit;
                }


                if (params.adsr.enabled) {
                    const atk = params.adsr.attack; const dcy = params.adsr.decay; const sus = params.adsr.sustain * velocity;
                    unit.mainNoteGain.gain.setValueAtTime(0, now); unit.mainNoteGain.gain.linearRampToValueAtTime(velocity, now + atk); unit.mainNoteGain.gain.linearRampToValueAtTime(sus, now + atk + dcy);
                } else { 
                    unit.mainNoteGain.gain.setValueAtTime(0, now);
                    unit.mainNoteGain.gain.linearRampToValueAtTime(velocity, now + 0.001); 
                }

                if (params.filter.enabled) {
                    unit.mainNoteGain.connect(filterNode);
                    if (!synthParamsOverride || slotId === -1) { 
                         filterNode.type = params.filter.type;
                         filterNode.frequency.setTargetAtTime(params.filter.cutoff, now, 0.01);
                         filterNode.Q.setTargetAtTime(params.filter.resonance, now, 0.01);
                    } else { 
                         filterNode.type = params.filter.type;
                         filterNode.frequency.setValueAtTime(params.filter.cutoff, now); 
                         filterNode.Q.setValueAtTime(params.filter.resonance, now);
                    }
                } else {
                    unit.mainNoteGain.connect(filterBypassGain);
                }


                // Every oscillator in the bank, layered; live notes also feed the oscilloscope's per-oscillator taps.
                const oscillators = params.oscillators;
                unit.layers = window.oscillatorBank.buildVoice(audioContext, oscillators, {
                    frequency: noteToFrequency(noteString, 0), when: now, slop: params.common.oscSlop, noise: whiteNoiseBuffer,
                    out: unit.mainNoteGain, taps: slotId === -1 ? oscillators.map((_, i) => oscTap(i).sum) : []
                });
                unit.oscillators = unit.layers.map(l => l.source);

                if (slotId !== -1) {
                    loopSlotsData[slotId].notesCurrentlyPlaying.add(noteString);
                } else { 
                    if (sustainPedalActive) notesSustained.add(noteString);
                    cycleLEDs(); 
                    if (synthesiaToggle.checked) startFallingNote(noteString);
                }
                return unit;
            }

            function stopNote(noteString, source = "unknown", synthParamsOverride = null) {
                const params = synthParamsOverride || getCurrentSynthParams();
                const slotId = source.startsWith('looper-slot-') ? parseInt(source.split('-')[2]) : -1;

                if (slotId === -1 && currentArmedSlotId !== -1 && loopSlotsData[currentArmedSlotId].isRecording) {
                     recordEvent(currentArmedSlotId, 'noteoff', noteString, 0, null);
                }

                if (slotId === -1) { 
                    if (sustainPedalActive && source!=='sustain_release' && source!=='emergency' && source!=='octave_change' && source!=='num_octaves_change') {
                        notesSustained.add(noteString);
                         if (source==="computer" || source==="touch-end" || source==="mouse-drag-end") { const kEl=keyboardContainer.querySelector(`[data-note="${noteString}"]`); if(kEl)kEl.classList.remove('active'); if(source==="computer")activeComputerKeys.delete(noteString);}
                        if(synthesiaToggle.checked) releaseFallingNote(noteString);
                        return;
                    }
                    if (!audioContext || !activeSoundUnits[noteString]) return;
                } else { 
                    if (!audioContext || !loopSlotsData[slotId] || !loopSlotsData[slotId].soundUnits[noteString] || loopSlotsData[slotId].soundUnits[noteString].length === 0) return;
                }

                const unit = (slotId !== -1) 
                    ? loopSlotsData[slotId].soundUnits[noteString].shift() 
                    : activeSoundUnits[noteString];

                if (!unit) return; 
                emitNote(noteString, 0, false, source);

                const now = audioContext.currentTime; 
                let relTime;

                if (params.adsr.enabled) {
                    relTime = params.adsr.release;
                    let cGV = 0; try {cGV = unit.mainNoteGain.gain.value;}catch(e){}
                    unit.mainNoteGain.gain.cancelScheduledValues(now); unit.mainNoteGain.gain.setValueAtTime(Math.max(cGV,0.00001),now); unit.mainNoteGain.gain.exponentialRampToValueAtTime(0.0001, now + relTime);
                } else { 
                    relTime = 0.001; 
                    let cGV = 0; try {cGV = unit.mainNoteGain.gain.value;}catch(e){}
                    unit.mainNoteGain.gain.cancelScheduledValues(now); unit.mainNoteGain.gain.setValueAtTime(Math.max(cGV,0.00001),now);
                    unit.mainNoteGain.gain.exponentialRampToValueAtTime(0.0001, now + relTime);
                }

                const sT = now + relTime + 0.05;
                unit.oscillators.forEach(osc => { try { osc.stop(sT); } catch(e){} });
                releasingUnits.add(unit);
                
                setTimeout(() => {
                    releasingUnits.delete(unit);
                    if(unit.mainNoteGain) unit.mainNoteGain.disconnect();
                    unit.layers.forEach(l => l.nodes.forEach(n => n.disconnect())); // the oscilloscope taps too
                }, (relTime + 0.15) * 1000);

                if (slotId === -1) { 
                    delete activeSoundUnits[noteString];
                    if (notesSustained.has(noteString) && source === 'sustain_release') notesSustained.delete(noteString);
                    if (synthesiaToggle.checked) releaseFallingNote(noteString);
                } else { 
                    loopSlotsData[slotId].notesCurrentlyPlaying.delete(noteString);
                }
            }

            function setupKeyboardEvents() { keyboardContainer.addEventListener('mousedown', e => { if (!audioContext) initAudio(); if (!audioContext || e.button !== 0) return; const tK = e.target.closest('.white-key, .black-key'); if (tK) { isMouseDraggingOnKeyboard = true; document.body.style.userSelect = 'none'; const n = tK.dataset.note; playNote(n, 0.7, "mouse-drag-start", true); tK.classList.add('active'); currentDraggedKeyElement = tK; } }); document.addEventListener('mousemove', e => { if (!isMouseDraggingOnKeyboard) return; const kUM = document.elementFromPoint(e.clientX, e.clientY)?.closest('.white-key, .black-key'); if (kUM && kUM !== currentDraggedKeyElement) { if (currentDraggedKeyElement) { stopNote(currentDraggedKeyElement.dataset.note, "mouse-drag-slide-out"); if (!sustainPedalActive) currentDraggedKeyElement.classList.remove('active'); } const n = kUM.dataset.note; playNote(n, 0.7, "mouse-drag-slide-in", true); kUM.classList.add('active'); currentDraggedKeyElement = kUM; } else if (!kUM && currentDraggedKeyElement) { stopNote(currentDraggedKeyElement.dataset.note, "mouse-drag-off-key"); if (!sustainPedalActive) currentDraggedKeyElement.classList.remove('active'); currentDraggedKeyElement = null; } }); document.addEventListener('mouseup', e => { if (e.button !== 0) return; if (isMouseDraggingOnKeyboard) { if (currentDraggedKeyElement) { stopNote(currentDraggedKeyElement.dataset.note, "mouse-drag-end"); if (!sustainPedalActive) currentDraggedKeyElement.classList.remove('active'); } isMouseDraggingOnKeyboard = false; document.body.style.userSelect = ''; currentDraggedKeyElement = null; } }); keyboardContainer.addEventListener('touchstart', e => { if (!audioContext) initAudio(); if (!audioContext) return; e.preventDefault(); for (let t of e.changedTouches) { const tK = document.elementFromPoint(t.clientX, t.clientY)?.closest('.white-key, .black-key'); if (tK) { const n = tK.dataset.note; playNote(n, 0.7, "touch-start", true); tK.classList.add('active'); activeTouches.set(t.identifier, tK); } } }, { passive: false }); keyboardContainer.addEventListener('touchmove', e => { if (!audioContext) return; e.preventDefault(); for (let t of e.changedTouches) { const tI = t.identifier; const kUT = document.elementFromPoint(t.clientX, t.clientY)?.closest('.white-key, .black-key'); const pKFT = activeTouches.get(tI); if (kUT !== pKFT) { if (pKFT) { stopNote(pKFT.dataset.note, "touch-slide-out"); if (!sustainPedalActive) pKFT.classList.remove('active'); } if (kUT) { const n = kUT.dataset.note; playNote(n, 0.7, "touch-slide-in", true); kUT.classList.add('active'); activeTouches.set(tI, kUT); } else { activeTouches.delete(tI); } } } }, { passive: false }); keyboardContainer.addEventListener('touchend', e => { e.preventDefault(); for (let t of e.changedTouches) { const tI = t.identifier; const rK = activeTouches.get(tI); if (rK) { stopNote(rK.dataset.note, "touch-end"); if (!sustainPedalActive) rK.classList.remove('active'); activeTouches.delete(tI); } } }, { passive: false }); keyboardContainer.addEventListener('touchcancel', e => { e.preventDefault(); for (let t of e.changedTouches) { const tI = t.identifier; const cK = activeTouches.get(tI); if (cK) { stopNote(cK.dataset.note, "touch-cancel"); if (!sustainPedalActive) cK.classList.remove('active'); activeTouches.delete(tI); } } }, { passive: false }); document.addEventListener('keydown', e => { if (e.target.closest('input, select, button, summary')) return; if (e.code === 'Space') { e.preventDefault(); if (!sustainPedalActive) { sustainPedalActive = true; activeComputerKeys.forEach(nS => playNote(nS, 0.7, "sustain_retrigger", false)); } } else if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) { const k = e.key.toLowerCase(); if (!Object.prototype.hasOwnProperty.call(keyMapping, k)) return; const kI = keyMapping[k]; const kEl = keyboardContainer.querySelector(`[data-keymap-index="${kI}"]`); if (kEl && !activeComputerKeys.has(kEl.dataset.note)) { playNote(kEl.dataset.note, 0.7, "computer", true); kEl.classList.add('active'); activeComputerKeys.add(kEl.dataset.note); } } }); document.addEventListener('keyup', e => { if (e.target.closest('input, select, button, summary')) return; if (e.code === 'Space') { e.preventDefault(); if (sustainPedalActive) { sustainPedalActive = false; const nTR = new Set(notesSustained); nTR.forEach(nS => { if (!activeComputerKeys.has(nS) && !isKeyHeldByMouseOrTouch(nS)) { stopNote(nS, "sustain_release"); } }); notesSustained.clear(); } } else { const k = e.key.toLowerCase(); if (!Object.prototype.hasOwnProperty.call(keyMapping, k)) return; const kI = keyMapping[k]; const kEl = keyboardContainer.querySelector(`[data-keymap-index="${kI}"]`); if (kEl && activeComputerKeys.has(kEl.dataset.note)) { stopNote(kEl.dataset.note, "computer"); activeComputerKeys.delete(kEl.dataset.note); if (!sustainPedalActive) kEl.classList.remove('active'); } } }); }
            function isKeyHeldByMouseOrTouch(noteString) { if (currentDraggedKeyElement && currentDraggedKeyElement.dataset.note === noteString) return true; for (const kEl of activeTouches.values()) { if (kEl.dataset.note === noteString) return true; } return false; }

            function setupControlEvents() {
                const sAPT = (p, v) => { if (audioContext && p) p.setTargetAtTime(parseFloat(v), audioContext.currentTime, 0.01);};
                // A held note follows its oscillators' level and pulse width (looper notes keep their recorded sound).
                window.addEventListener('synth:oscillator', ({ detail: { id, level, pulseWidth } }) => {
                    Object.values(activeSoundUnits).forEach(u => {
                        const layer = (!u.source || !u.source.startsWith('looper-slot-')) && u.layers.find(l => l.id === id);
                        if (!layer) return;
                        if (level !== undefined) sAPT(layer.gain.gain, level);
                        if (pulseWidth !== undefined && layer.pulse) layer.source.setPeriodicWave(window.oscillatorBank.pulseWave(audioContext, pulseWidth));
                    });
                });

                baseOctaveSelect.addEventListener('change', () => { Object.keys(activeSoundUnits).forEach(n => stopNote(n, "octave_change")); createKeyboard(); });
                numOctavesSelect.addEventListener('change', () => { Object.keys(activeSoundUnits).forEach(n => stopNote(n, "num_octaves_change")); createKeyboard(); });

                filterTypeSelect.addEventListener('change', () => { if (filterNode && (!activeSoundUnits[Object.keys(activeSoundUnits)[0]]?.source?.startsWith('looper-slot-'))) filterNode.type = filterTypeSelect.value; }); 
                filterCutoffInput.addEventListener('input', () => { if (filterNode && (!activeSoundUnits[Object.keys(activeSoundUnits)[0]]?.source?.startsWith('looper-slot-'))) sAPT(filterNode.frequency, filterCutoffInput.value); });
                filterResonanceInput.addEventListener('input', () => { if (filterNode && (!activeSoundUnits[Object.keys(activeSoundUnits)[0]]?.source?.startsWith('looper-slot-'))) sAPT(filterNode.Q, filterResonanceInput.value); });

                masterVolumeInput.addEventListener('input', () => sAPT(masterGain?.gain, masterVolumeInput.value));
                uiThemeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
                uiScaleInput.addEventListener('input', (e) => applyUIScale(parseFloat(e.target.value)));
                synthesiaToggle.addEventListener('change', (e) => { synthesiaContainer.classList.toggle('active', e.target.checked); localStorage.setItem('synthesiaEnabled', e.target.checked); if (e.target.checked) { createSynthesiaGrid(); } else { clearSynthesiaGrid(); activeVisualNoteElements.forEach(d => { if (d.element && d.element.parentElement) d.element.remove(); }); activeVisualNoteElements = []; } });
                stopAllSoundsButton.addEventListener('click', emergencyStopAllSounds);
                // Coming back to the tab stops every sound: notes, loops and the sequencer left going while it was
                // hidden would carry on late or stuck. (A page restored from the back/forward cache counts too.)
                document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') emergencyStopAllSounds(); });
                window.addEventListener('pageshow', e => { if (e.persisted) emergencyStopAllSounds(); });

                enableAdsrToggle.addEventListener('change', (e) => { adsrControls.style.display = e.target.checked ? '' : 'none'; });
                enableFilterToggle.addEventListener('change', (e) => { filterControlsElement.style.display = e.target.checked ? '' : 'none'; });

                adsrControls.style.display = enableAdsrToggle.checked ? '' : 'none';
                filterControlsElement.style.display = enableFilterToggle.checked ? '' : 'none';

                toggleLooperButton.addEventListener('click', () => {
                    launchpadLooperContainer.classList.toggle('open');
                    toggleLooperButton.textContent = launchpadLooperContainer.classList.contains('open') ? 'Hide Looper' : 'Show Looper';
                });
            }



            // Lets plug-in instruments follow every note source: keyboard, MIDI, sequencer, and looper.
            // `source` is the playNote/stopNote source ("midi", "computer", "sequencer", "looper-slot-0", ...).
            // `time` is when the note was played, on the page's clock: a MIDI message's own time stamp when there is
            // one (it is taken as the key goes down, before the page gets to it), else now.
            let midiNoteTime = null;
            function emitNote(noteString, velocity, on, source) { const nN=noteString.replace(/\d+$/,''); const midi=parseInt(noteString.match(/\d+$/)[0])*12+midiNoteNames.indexOf(nN); window.dispatchEvent(new CustomEvent('synth:note',{detail:{note:noteString,midi,velocity,on,source,time:source==='midi'&&midiNoteTime?midiNoteTime:performance.now()}})); }

            function emergencyStopAllSounds() {
                console.warn("PANIC: Stopping all sounds!"); 
                window.dispatchEvent(new Event('synth:panic'));

                if(!audioContext)return; 
                const now = audioContext.currentTime; 
                
                Object.keys(activeSoundUnits).forEach(noteKey => { 
                    const unit = activeSoundUnits[noteKey]; 
                    if (unit.mainNoteGain) { 
                        unit.mainNoteGain.gain.cancelScheduledValues(now); 
                        unit.mainNoteGain.gain.setValueAtTime(Math.max(unit.mainNoteGain.gain.value, 0.0001), now); 
                        unit.mainNoteGain.gain.exponentialRampToValueAtTime(0.00001, now + 0.05);
                        setTimeout(() => {
                            if (unit.mainNoteGain.numberOfOutputs > 0) unit.mainNoteGain.disconnect();
                        }, 100); 
                    } 
                    unit.oscillators.forEach(osc => { try { osc.stop(now + 0.05); setTimeout(() => {if (osc.numberOfOutputs > 0) osc.disconnect();}, 100); } catch (e) {} }); 
                    delete activeSoundUnits[noteKey];
                });
                activeComputerKeys.clear(); activeTouches.clear(); 
                if(currentDraggedKeyElement){ currentDraggedKeyElement.classList.remove('active'); currentDraggedKeyElement=null;} 
                isMouseDraggingOnKeyboard=false; document.body.style.userSelect=''; 
                keyboardContainer.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); 
                
                activeVisualNoteElements.forEach(d => { if(d.animationFrameId) cancelAnimationFrame(d.animationFrameId); if(d.element && d.element.parentElement) d.element.remove(); }); 
                activeVisualNoteElements = []; 
                sustainPedalActive = false; notesSustained.clear(); 
                
                if (looperQuantizationTimeout) clearTimeout(looperQuantizationTimeout);
                looperQuantizationTimeout = null;
                
                // For Panic, stop looper activity but DO NOT clear recorded data
                loopSlotsData.forEach((slot, slotId) => {
                    if (slot.isRecording) {
                        slot.isRecording = false;
                        // Update status but don't finalize loop duration as it's a panic
                        slot.statusText = slot.recordedEvents.length > 0 ? `Rec Aborted (${(slot.loopDuration / 1000).toFixed(1)}s)` : "Rec Aborted";
                    }
                    if (slot.isPlaying) {
                        stopPlaybackForSlot(slotId, true); // true for emergency stop, preserves data
                    }
                    // Status will be "Panic Stop" or "Rec Aborted" if it was playing/recording.
                    // If idle but has data, it remains. If empty, it's "Empty".
                    else if (!slot.isRecording && !slot.isPlaying && slot.recordedEvents.length > 0 && slot.loopDuration > 0){
                        slot.statusText = `Stopped (${(slot.loopDuration / 1000).toFixed(1)}s)`;
                    } else if (!slot.isRecording && !slot.isPlaying) {
                        slot.statusText = "Empty";
                    }
                });
                currentArmedSlotId = -1; 
                updateAllLoopSlotButtons(); // This will reflect the new statuses

                // Notes already let go (the sequencer's, the loops' just stopped, or keys released) fade within
                // 50 ms instead of ringing out their release.
                const cut = audioContext.currentTime;
                releasingUnits.forEach(unit => {
                    unit.mainNoteGain.gain.cancelScheduledValues(cut);
                    unit.mainNoteGain.gain.setValueAtTime(Math.max(unit.mainNoteGain.gain.value, 0.0001), cut);
                    unit.mainNoteGain.gain.exponentialRampToValueAtTime(0.00001, cut + 0.05);
                    unit.oscillators.forEach(osc => { try { osc.stop(cut + 0.05); } catch (e) {} });
                });

                stopMetronome();
                metronomeEnabled = false; if(metronomeToggle) metronomeToggle.checked = false; if(metronomeLed) metronomeLed.classList.remove('active'); 
                console.log("All sounds and states (looper, metronome, sustain) reset. Looper data preserved."); 
            }

            function visualize() { requestAnimationFrame(visualize); if (!audioContext || !visualizerContext || !visualizerCanvas) return; let currentAnalyser = analyser; const oscN = /^osc(\d+)$/.exec(visualizerSourceSelect ? visualizerSourceSelect.value : ''); if (oscN) currentAnalyser = oscTap(Number(oscN[1]) - 1).analyser; if (!currentAnalyser) return; const bL=currentAnalyser.frequencyBinCount;const dA=new Uint8Array(bL);currentAnalyser.getByteTimeDomainData(dA);visualizerContext.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--primary-surface-color').trim();visualizerContext.fillRect(0,0,visualizerCanvas.width,visualizerCanvas.height);visualizerContext.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim();visualizerContext.lineWidth=0.5*parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor'));const nVL=4;for(let i=1;i<nVL;i++){const x=(visualizerCanvas.width/nVL)*i;visualizerContext.beginPath();visualizerContext.moveTo(x,0);visualizerContext.lineTo(x,visualizerCanvas.height);visualizerContext.stroke();}const nHL=2;for(let i=1;i<=nHL;i++){const y1=visualizerCanvas.height*(0.5-0.25*i);const y2=visualizerCanvas.height*(0.5+0.25*i);visualizerContext.beginPath();visualizerContext.moveTo(0,y1);visualizerContext.lineTo(visualizerCanvas.width,y1);visualizerContext.stroke();visualizerContext.beginPath();visualizerContext.moveTo(0,y2);visualizerContext.lineTo(visualizerCanvas.width,y2);visualizerContext.stroke();}visualizerContext.lineWidth=2.5*parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor'));const aC=getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();visualizerContext.strokeStyle=aC;visualizerContext.shadowBlur=10*parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor'));visualizerContext.shadowColor=aC;visualizerContext.beginPath();const sW=visualizerCanvas.width*1.0/bL;let x=0;for(let i=0;i<bL;i++){const v=dA[i]/128.0;const y=v*visualizerCanvas.height/2;if(i===0)visualizerContext.moveTo(x,y);else visualizerContext.lineTo(x,y);x+=sW;}visualizerContext.lineTo(visualizerCanvas.width,visualizerCanvas.height/2);visualizerContext.stroke();visualizerContext.shadowBlur=0; }
            let activeLEDIndex=0;const genLeds=[document.getElementById('led1'),document.getElementById('led2'),document.getElementById('led3')]; function cycleLEDs(){genLeds.forEach(l=>l.classList.remove('active'));if(genLeds[activeLEDIndex])genLeds[activeLEDIndex].classList.add('active');activeLEDIndex=(activeLEDIndex+1)%genLeds.length;}
            function resizeCanvas() { if (visualizerCanvas) { visualizerCanvas.width = visualizerCanvas.clientWidth; visualizerCanvas.height = visualizerCanvas.clientHeight; if (audioContext && analyser) { const sR = audioContext.sampleRate; const bTM = (analyser.fftSize / 2 / sR * 1000).toFixed(0); const fBTM = (analyser.fftSize / sR * 1000).toFixed(0); const tAL = visualizerCanvas.parentElement.querySelector('.visualizer-time-axis').children; if (tAL[1]) tAL[1].textContent = `~${bTM}ms`; if (tAL[2]) tAL[2].textContent = `~${fBTM}ms`; } } if (synthesiaToggle && synthesiaToggle.checked) createSynthesiaGrid(); }
            function setupMIDI(){ if(navigator.requestMIDIAccess)navigator.requestMIDIAccess({sysex:false}).then(onS,onF);else console.warn("No MIDI support.");} function onS(mA){const iN=mA.inputs.values();for(let n=iN.next();n&&!n.done;n=iN.next())n.value.onmidimessage=onM;} function onF(m){console.error(`Failed MIDI: ${m}`);}
            // MIDI clock (tick, start, continue, stop) goes to the beat clock as synth:midi-clock; notes play.
            const MIDI_CLOCK = { 0xF8: 'tick', 0xFA: 'start', 0xFB: 'continue', 0xFC: 'stop' };
            function onM(msg){ if (msg.data[0] >= 0xF8) { const type = MIDI_CLOCK[msg.data[0]]; if (type) window.dispatchEvent(new CustomEvent('synth:midi-clock', { detail: { type, time: msg.timeStamp || performance.now() } })); return; } midiNoteTime = msg.timeStamp || null; onNoteMessage(msg); midiNoteTime = null; }
            function onNoteMessage(msg){ const[cmd,nN,vR]=msg.data; const nS=midiNoteToNoteString(nN); const vL=vR/127; const kE=keyboardContainer.querySelector(`[data-midi="${nN}"]`); if((cmd&0xF0)===0x90&&vR>0){ playNote(nS,vL,"midi",true); if(kE)kE.classList.add('active');}else if((cmd&0xF0)===0x80||((cmd&0xF0)===0x90&&vR===0)){ stopNote(nS,"midi"); if(kE && !sustainPedalActive)kE.classList.remove('active');}}
            // The falling-notes area as a piano roll: a lane over every key, placed exactly as falling notes are
            // (proportionally from the key's place on the keyboard), black-key lanes shaded. Redrawn whenever the
            // keyboard changes size or keys.
            function createSynthesiaGrid(){ clearSynthesiaGrid();const cH=synthesiaContainer.clientHeight;const sc=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor'));const nHL=Math.max(1, Math.floor(cH / (50 * sc)));for(let i=1;i<nHL;i++){const l=document.createElement('div');l.className='synthesia-grid-line horizontal';l.style.top=`${(cH/nHL)*i}px`;synthesiaContainer.appendChild(l);}const kR=keyboardContainer.getBoundingClientRect();const toArea=kR.width?synthesiaContainer.getBoundingClientRect().width/kR.width:1;keyboardContainer.querySelectorAll('[data-midi]').forEach(k=>{const r=k.getBoundingClientRect();const lane=document.createElement('div');lane.className=`synthesia-grid-line lane ${k.dataset.isBlack==='true'?'black':'white'}`;lane.style.left=`${(r.left-kR.left)*toArea-synthesiaContainer.clientLeft}px`;lane.style.width=`${r.width*toArea}px`;synthesiaContainer.appendChild(lane);});}
            function clearSynthesiaGrid(){ synthesiaContainer.querySelectorAll('.synthesia-grid-line').forEach(el=>el.remove());}
            
            function startFallingNote(noteString){ 
                if (!synthesiaToggle.checked || !audioContext) return; 
                const keyElement = keyboardContainer.querySelector(`[data-note="${noteString}"]`); 
                if (!keyElement) return; 
                const noteRect = keyElement.getBoundingClientRect(); 
                const keyboardRect = keyboardContainer.getBoundingClientRect(); 
                const fallingElement = document.createElement('div'); 
                fallingElement.classList.add('falling-note'); 
                fallingElement.classList.toggle('white', !JSON.parse(keyElement.dataset.isBlack)); 
                fallingElement.classList.toggle('black', JSON.parse(keyElement.dataset.isBlack)); 
                fallingElement.textContent = noteString.replace(/\d+$/,''); 
                // Map the key's place on the keyboard onto the falling-notes area proportionally, so notes line
                // up with their keys even if the two differ in width.
                const toArea = keyboardRect.width ? synthesiaContainer.getBoundingClientRect().width / keyboardRect.width : 1;
                fallingElement.style.left = `${(noteRect.left - keyboardRect.left) * toArea - synthesiaContainer.clientLeft}px`; // less the area's border
                fallingElement.style.width = `${noteRect.width * toArea}px`;
                fallingElement.style.top = '0px'; 
                const initialHeight = MIN_FALLING_NOTE_HEIGHT * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor')); 
                fallingElement.style.height = `${initialHeight}px`; 
                fallingElement.dataset.noteString = noteString; 
                fallingElement.dataset.startTime = performance.now().toString(); 
                fallingElement.dataset.isReleasing = "false"; 
                fallingElement.dataset.releaseStartTime = "0";
                fallingElement.dataset.hasHit = "false"; // For burst effect
                fallingElement.dataset.burstComplete = "false"; // For burst removal
                synthesiaContainer.appendChild(fallingElement); 
                const animationData = { element: fallingElement, animationFrameId: null }; 
                activeVisualNoteElements.push(animationData); 
                const animate = (timestamp) => { animateFallingNoteElement(animationData, timestamp); }; 
                animationData.animationFrameId = requestAnimationFrame(animate);
            }

            function animateFallingNoteElement(animationData, currentTime) { 
                const { element } = animationData; 
                if (!element || !element.parentElement) { 
                    activeVisualNoteElements = activeVisualNoteElements.filter(ad => ad !== animationData); 
                    return; 
                }
                if (element.dataset.burstComplete === "true") {
                    if (element.parentElement) element.remove();
                    activeVisualNoteElements = activeVisualNoteElements.filter(ad => ad !== animationData);
                    return;
                }

                const startTime = parseFloat(element.dataset.startTime); 
                const isReleasing = element.dataset.isReleasing === "true"; 
                const releaseStartTime = parseFloat(element.dataset.releaseStartTime); 
                const fontScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale-factor')); 
                const containerHeight = synthesiaContainer.clientHeight; 
                const hitLineEl = synthesiaContainer.querySelector('.synthesia-hit-line');
                const hitLineRect = hitLineEl ? hitLineEl.getBoundingClientRect() : null;
                const containerRect = synthesiaContainer.getBoundingClientRect();

                // Original Synthesia note grows towards the line
                let noteDurationEstimate = (enableAdsrToggle.checked ? (parseFloat(attackInput.value) + parseFloat(decayInput.value)) : 0.01) + 0.5; 
                const fallSpeed = Math.max(10, (containerHeight - (hitLineRect ? hitLineRect.height : 10 * fontScale)) / noteDurationEstimate); 
                
                // Burst detection (when bottom of growing note hits the line)
                if (hitLineRect && element.dataset.hasHit === "false" && !isReleasing) {
                    const noteRect = element.getBoundingClientRect();
                    if (noteRect.bottom >= hitLineRect.top && noteRect.top < containerRect.bottom ) { // Check if it visually touches/crosses
                        element.classList.add('burst');
                        element.dataset.hasHit = "true";
                        setTimeout(() => {
                            element.dataset.burstComplete = "true"; 
                        }, BURST_ANIMATION_DURATION);
                    }
                }

                if (element.classList.contains('burst')) {
                    // CSS handles animation. RAF continues for eventual removal.
                } else if (isReleasing) { 
                    const timeSinceReleaseStarted = currentTime - releaseStartTime; 
                    const releaseProgress = Math.min(timeSinceReleaseStarted / NOTE_TAIL_DURATION_MS_VISUAL, 1); 
                    const initialTop = 0; // Not really used as transform is applied
                    const fallDistance = initialTop + (timeSinceReleaseStarted / 1000) * fallSpeed * 1.5; 
                    element.style.transform = `translateY(${fallDistance}px)`; 
                    element.style.opacity = `${0.9 * (1 - releaseProgress * 0.7)}`; 
                } else { // Growing phase
                    const elapsedMs = currentTime - startTime; 
                    const currentHeight = Math.max(MIN_FALLING_NOTE_HEIGHT * fontScale, (elapsedMs / 1000) * fallSpeed * 0.5); 
                    element.style.height = `${currentHeight}px`; 
                    element.style.transform = 'translateY(0px)'; 
                }
                
                // Continue animation?
                if (element.dataset.burstComplete !== "true") {
                    const noteRectForBounds = element.getBoundingClientRect();
                    if (!isReleasing || (isReleasing && parseFloat(element.style.opacity) > 0.01 && noteRectForBounds.top < containerRect.bottom + 50)) {
                         animationData.animationFrameId = requestAnimationFrame(ts => animateFallingNoteElement(animationData, ts));
                    } else if (isReleasing) { // Finished release fall (and not bursting)
                         if (element.parentElement) element.remove();
                         activeVisualNoteElements = activeVisualNoteElements.filter(ad => ad !== animationData);
                    }
                }
            }
            function releaseFallingNote(noteString) { 
                if (!synthesiaToggle.checked) return; 
                const now = performance.now(); 
                activeVisualNoteElements.forEach(animationData => { 
                    const { element } = animationData; 
                    if (element && element.dataset.noteString === noteString && element.dataset.isReleasing === "false" && !element.classList.contains('burst')) { 
                        element.dataset.isReleasing = "true"; 
                        element.dataset.releaseStartTime = now.toString(); 
                        element.classList.add('releasing'); 
                    }
                });
            }

            function updateBPMDisplay() { if(bpmDisplay) bpmDisplay.textContent = currentBPM; window.dispatchEvent(new CustomEvent('synth:tempo',{detail:currentBPM})); }
            // The metronome's clicks are scheduled on the audio clock, a beat apart from when it started, so they
            // land exactly on the beat that the timing strip and the teacher measure against (js/timing-widget.js),
            // however busy the page is: a timer only looks 100 ms ahead every 25 ms. The beat clock is told when
            // the first click will be heard (synth:beat-clock), and again whenever the metronome starts over.
            let metronomeOrigin = 0, metronomeNext = 0, metronomeSources = [];
            // When something scheduled at audio time t will be heard, on the page's clock (performance.now()).
            function perfTimeOf(t) { const ts = audioContext.getOutputTimestamp?.(); if (ts && ts.performanceTime > 0) return ts.performanceTime + (t - ts.contextTime) * 1000; return performance.now() + (t - audioContext.currentTime + (audioContext.outputLatency || audioContext.baseLatency || 0)) * 1000; }
            function announceBeat(source, running, at = 0) { window.dispatchEvent(new CustomEvent('synth:beat-clock', { detail: { source, running, bpm: currentBPM, at } })); }
            function playMetronomeClickSound(at) { if (!audioContext || !metronomeClickBuffer) return; const s=audioContext.createBufferSource(); s.buffer=metronomeClickBuffer; const g=audioContext.createGain(); g.gain.value=0.25; s.connect(g).connect(audioContext.destination); s.start(at ?? audioContext.currentTime); if (at) { metronomeSources.push(s); s.onended = () => { metronomeSources = metronomeSources.filter(x => x !== s); }; } }
            function metronomeTick(at) { if (!metronomeEnabled || !metronomeLed) return; playMetronomeClickSound(at); const wait = at ? Math.max(0, (at - audioContext.currentTime) * 1000) : 0; setTimeout(() => { if (!metronomeEnabled || !metronomeLed) return; metronomeLed.classList.add('active'); setTimeout(() => metronomeLed?.classList.remove('active'), 50); }, wait); }
            function scheduleClicks() { const p = 60 / currentBPM; while (metronomeOrigin + metronomeNext * p < audioContext.currentTime + 0.1) { metronomeTick(metronomeOrigin + metronomeNext * p); metronomeNext++; } }
            function startMetronome() { if (!audioContext) initAudio(); if (!audioContext) { alert("Audio not ready."); if(metronomeToggle)metronomeToggle.checked=false; return; } stopMetronome(false); metronomeOrigin = audioContext.currentTime + 0.05; metronomeNext = 0; metronomeIntervalId = setInterval(scheduleClicks, 25); scheduleClicks(); announceBeat('metronome', true, perfTimeOf(metronomeOrigin)); }
            function stopMetronome(announce = true) { if(metronomeIntervalId)clearInterval(metronomeIntervalId); metronomeIntervalId=null; if(metronomeLed)metronomeLed.classList.remove('active'); metronomeSources.forEach(s => { try { s.stop(); } catch (e) {} }); metronomeSources = []; if (announce) announceBeat('metronome', false); }
            function toggleMetronome() { if(!metronomeToggle) return; metronomeEnabled = metronomeToggle.checked; if (metronomeEnabled) startMetronome(); else stopMetronome();}
            function adjustBPM(amount) { currentBPM=Math.max(MIN_BPM,Math.min(MAX_BPM,currentBPM+amount)); updateBPMDisplay(); if(metronomeEnabled){stopMetronome();startMetronome();}}
            function handleTapTempo() { if(!audioContext)initAudio(); if(!audioContext)return; const n=performance.now(); if(tapTempoLastTap&&(n-tapTempoLastTap>MAX_TAP_INTERVAL)){tapTempoTimes.length=0;} tapTempoTimes.push(n); tapTempoLastTap=n; if(tapTempoTimes.length>4)tapTempoTimes.shift(); if(tapTempoTimes.length>=2){let aI=0; for(let i=1;i<tapTempoTimes.length;i++){aI+=tapTempoTimes[i]-tapTempoTimes[i-1];} aI/=(tapTempoTimes.length-1); if(aI>0){currentBPM=Math.round(60000/aI);currentBPM=Math.max(MIN_BPM,Math.min(MAX_BPM,currentBPM)); updateBPMDisplay(); if(metronomeEnabled){stopMetronome();startMetronome();}}}}
            function getBeatDurationMs() { return (60 / currentBPM) * 1000; }
            // Armed loops start on the metronome's own next beat.
            function getTimeUntilNextBeatMs() { if (!metronomeEnabled || !audioContext || audioContext.state !== 'running') return 0; const bDS = 60/currentBPM; const cTIB = ((audioContext.currentTime - metronomeOrigin) % bDS + bDS) % bDS; return (bDS - cTIB) * 1000;}

            // --- Launchpad Looper Functions ---
            function initializeLoopSlots() {
                loopSlotsData = [];
                launchpadLooperContainer.innerHTML = ''; 
                for (let i = 0; i < NUM_LOOP_SLOTS; i++) {
                    loopSlotsData.push({
                        id: i, recordedEvents: [], loopDuration: 0, loopStartTime: 0, 
                        isRecording: false, isPlaying: false, playbackScheduledEvents: [],
                        notesCurrentlyPlaying: new Set(), soundUnits: {}, 
                        statusText: "Empty", quantizeStartTime: 0 
                    });
                    createLoopSlotUI(i);
                }
                updateAllLoopSlotButtons();
            }

            function createLoopSlotUI(slotId) {
                const slotData = loopSlotsData[slotId]; // Use slotData consistently
                const slotDiv = document.createElement('div');
                slotDiv.className = 'loop-slot';
                slotDiv.id = `loop-slot-${slotId}`;

                const title = document.createElement('div');
                title.className = 'loop-slot-title';
                title.textContent = `Slot ${slotId + 1}`;
                slotDiv.appendChild(title);
                
                const status = document.createElement('div');
                status.className = 'loop-slot-status'; // Added class for styling
                status.id = `loop-slot-status-${slotId}`;
                status.textContent = slotData.statusText;
                slotDiv.appendChild(status);

                const buttonsDiv = document.createElement('div');
                buttonsDiv.className = 'loop-slot-buttons';

                const armButton = document.createElement('button');
                armButton.id = `loop-slot-arm-${slotId}`;
                // Text content will be set by updateAllLoopSlotButtons
                armButton.classList.add('std-button');
                armButton.onclick = () => { // Refined onclick logic here for clarity
                    const currentSlot = loopSlotsData[slotId];
                    if (currentSlot.isRecording) { // If this slot is recording, action is to stop.
                        toggleRecordOnArmedSlot(); // Assumes currentArmedSlotId is this slotId
                    } else if (currentArmedSlotId === slotId && !currentSlot.isPlaying) { // If armed and not playing, action is to start/toggle record.
                        toggleRecordOnArmedSlot();
                    } else { // Otherwise, the action is to arm this slot.
                        armSlot(slotId);
                    }
                };
                buttonsDiv.appendChild(armButton);

                const playButton = document.createElement('button');
                playButton.id = `loop-slot-play-${slotId}`;
                playButton.textContent = 'Play';
                playButton.classList.add('std-button');
                playButton.onclick = () => togglePlaySlot(slotId);
                buttonsDiv.appendChild(playButton);

                const clearButton = document.createElement('button');
                clearButton.id = `loop-slot-clear-${slotId}`;
                clearButton.textContent = 'Clear';
                clearButton.classList.add('std-button');
                clearButton.onclick = () => clearSlot(slotId);
                buttonsDiv.appendChild(clearButton);
                
                slotDiv.appendChild(buttonsDiv);

                const ledsDiv = document.createElement('div');
                ledsDiv.className = 'loop-slot-leds';
                const armedLed = document.createElement('span');
                armedLed.className = 'led';
                armedLed.id = `loop-slot-armed-led-${slotId}`;
                armedLed.title = "Armed for Recording";
                ledsDiv.appendChild(armedLed);

                const recordLed = document.createElement('span');
                recordLed.className = 'led record-led'; 
                recordLed.id = `loop-slot-record-led-${slotId}`;
                recordLed.title = "Recording";
                ledsDiv.appendChild(recordLed);
                
                const playLed = document.createElement('span');
                playLed.className = 'led'; 
                playLed.id = `loop-slot-play-led-${slotId}`;
                playLed.title = "Playing";
                ledsDiv.appendChild(playLed);
                slotDiv.appendChild(ledsDiv);

                launchpadLooperContainer.appendChild(slotDiv);
            }

            function armSlot(slotIdToArm) {
                const slotToArmData = loopSlotsData[slotIdToArm];

                // If this slot is already recording, clicking its "Arm" button (now "Stop Rec") should stop it.
                // This case is handled by the armButton.onclick logic directly calling toggleRecordOnArmedSlot.
                // So, if slotToArmData.isRecording is true, this function shouldn't be called by its own arm button
                // unless it's to arm it *from another context* which should be disallowed.

                // If trying to arm an already armed slot (and it's not playing), toggle record.
                if (currentArmedSlotId === slotIdToArm && !slotToArmData.isPlaying && !slotToArmData.isRecording) {
                    toggleRecordOnArmedSlot();
                    return;
                }
                
                // If another slot is currently recording, don't allow arming a new one.
                if (currentArmedSlotId !== -1 && currentArmedSlotId !== slotIdToArm && loopSlotsData[currentArmedSlotId].isRecording) {
                    console.warn("Cannot arm a new slot while another is recording.");
                    // You could add a temporary status message to the clicked slot here
                    const tempStatusTarget = document.getElementById(`loop-slot-status-${slotIdToArm}`);
                    if(tempStatusTarget) {
                        const oldText = tempStatusTarget.textContent;
                        tempStatusTarget.textContent = "Other rec busy";
                        setTimeout(() => { if(tempStatusTarget.textContent === "Other rec busy") tempStatusTarget.textContent = oldText; }, 1500);
                    }
                    return;
                }

                // If the slot to arm is currently playing, it cannot be armed.
                if (slotToArmData.isPlaying) {
                    console.warn(`Slot ${slotIdToArm + 1} is playing. Cannot arm.`);
                     const tempStatusTarget = document.getElementById(`loop-slot-status-${slotIdToArm}`);
                    if(tempStatusTarget) {
                        const oldText = tempStatusTarget.textContent;
                        tempStatusTarget.textContent = "Slot playing";
                        setTimeout(() => { if(tempStatusTarget.textContent === "Slot playing") tempStatusTarget.textContent = oldText; }, 1500);
                    }
                    return;
                }

                // Disarm any previously armed slot IF it's not the one we're currently arming
                // AND if it's not currently recording (that case is handled above)
                if (currentArmedSlotId !== -1 && currentArmedSlotId !== slotIdToArm && !loopSlotsData[currentArmedSlotId].isRecording) {
                    // No specific action needed to "disarm" other than changing currentArmedSlotId
                }
                
                currentArmedSlotId = slotIdToArm;
                updateAllLoopSlotButtons();
            }


            function toggleRecordOnArmedSlot() {
                if (currentArmedSlotId === -1) {
                    // This case should ideally be handled by UI (e.g., disabling record button if no slot armed)
                    // or by arming a default slot if desired. For now, it's a guard.
                    console.warn("No slot armed for recording action.");
                    return;
                }
                if (!audioContext) initAudio();
                if (!audioContext) { alert("Audio not ready."); return; }

                const slot = loopSlotsData[currentArmedSlotId];
                if (slot.isPlaying) { 
                    console.warn(`Slot ${currentArmedSlotId + 1} is playing. Stop playback to record.`);
                    return;
                }

                if (looperQuantizationTimeout) { // Clear any pending quantization
                    clearTimeout(looperQuantizationTimeout);
                    looperQuantizationTimeout = null;
                }

                if (slot.isRecording) { // --- Stop recording ---
                    slot.isRecording = false;
                    let rawDuration = performance.now() - slot.loopStartTime;
                    if (slot.recordedEvents.length === 0) {
                        slot.loopDuration = 0;
                        slot.statusText = "Rec Empty";
                    } else {
                        if (metronomeEnabled) {
                            const beatMs = getBeatDurationMs();
                            slot.loopDuration = Math.max(beatMs, Math.round(rawDuration / beatMs) * beatMs);
                            slot.statusText = `Rec Q (${(slot.loopDuration / 1000).toFixed(1)}s)`;
                        } else {
                            slot.loopDuration = rawDuration;
                            slot.statusText = `Rec (${(slot.loopDuration / 1000).toFixed(1)}s)`;
                        }
                    }
                    // currentArmedSlotId remains the same, slot is now armed but not recording.
                } else { // --- Start recording ---
                    if (metronomeEnabled && audioContext.state === 'running') {
                        const delayMs = getTimeUntilNextBeatMs();
                        slot.statusText = "Wait Beat...";
                        updateAllLoopSlotButtons(); // Update status immediately
                        looperQuantizationTimeout = setTimeout(() => {
                            looperQuantizationTimeout = null;
                            startActualRecordingForSlot(currentArmedSlotId);
                        }, delayMs);
                    } else {
                        startActualRecordingForSlot(currentArmedSlotId);
                    }
                }
                updateAllLoopSlotButtons();
            }
            
            function startActualRecordingForSlot(slotId) {
                const slot = loopSlotsData[slotId];
                slot.recordedEvents = [];
                slot.loopDuration = 0;
                slot.soundUnits = {}; 
                slot.notesCurrentlyPlaying.clear(); 
                slot.loopStartTime = performance.now();
                slot.quantizeStartTime = audioContext.currentTime; 
                slot.isRecording = true;
                slot.statusText = "Recording...";
                updateAllLoopSlotButtons();
            }

            function recordEvent(slotId, type, note, velocity, synthParams) {
                const slot = loopSlotsData[slotId];
                if (!slot || !slot.isRecording) return;
                const time = performance.now() - slot.loopStartTime;
                const eventData = { type, note, velocity, time };
                if (type === 'noteon' && synthParams) {
                    eventData.synthParams = JSON.parse(JSON.stringify(synthParams)); 
                }
                slot.recordedEvents.push(eventData);
            }

            function togglePlaySlot(slotId) {
                if (!audioContext) initAudio();
                if (!audioContext) { alert("Audio not ready."); return; }

                const slot = loopSlotsData[slotId];
                if (slot.isRecording) return; 
                if (slot.recordedEvents.length === 0 || slot.loopDuration <= 0) { // Check loopDuration > 0
                    slot.statusText = "Loop Empty";
                    updateAllLoopSlotButtons();
                    setTimeout(() => { 
                        if(slot.statusText === "Loop Empty") slot.statusText = "Empty"; 
                        updateAllLoopSlotButtons();
                    }, 2000);
                    return;
                }

                if (looperQuantizationTimeout) { 
                    clearTimeout(looperQuantizationTimeout);
                    looperQuantizationTimeout = null;
                }

                if (slot.isPlaying) {
                    stopPlaybackForSlot(slotId);
                } else {
                    if (metronomeEnabled && audioContext.state === 'running') {
                        const delayMs = getTimeUntilNextBeatMs();
                        slot.statusText = "Wait Beat...";
                        updateAllLoopSlotButtons(); 
                        looperQuantizationTimeout = setTimeout(() => {
                            looperQuantizationTimeout = null;
                            startPlaybackForSlot(slotId);
                        }, delayMs);
                    } else {
                        startPlaybackForSlot(slotId);
                    }
                }
            }
            
            function startPlaybackForSlot(slotId) {
                const slot = loopSlotsData[slotId];
                slot.isPlaying = true;
                slot.statusText = `Playing (${(slot.loopDuration / 1000).toFixed(1)}s)`;
                slot.notesCurrentlyPlaying.clear();
                slot.soundUnits = {}; 
                
                let playbackStartAudioTime = audioContext.currentTime;
                if (metronomeEnabled && slot.quantizeStartTime > 0 && audioContext.state === 'running') {
                    const beatDurationSec = 60 / currentBPM;
                    const timeSinceOriginalQuantizedStart = playbackStartAudioTime - slot.quantizeStartTime;
                    const offsetIntoBeat = timeSinceOriginalQuantizedStart % beatDurationSec;
                    playbackStartAudioTime = playbackStartAudioTime - offsetIntoBeat + beatDurationSec;
                     if (playbackStartAudioTime <= audioContext.currentTime + 0.005) { 
                        playbackStartAudioTime = audioContext.currentTime + getTimeUntilNextBeatMs()/1000;
                     }
                }
                
                playbackLoopSlot(slotId, playbackStartAudioTime);
                updateAllLoopSlotButtons();
            }

            function stopPlaybackForSlot(slotId, emergency = false) {
                const slot = loopSlotsData[slotId];
                if (!slot.isPlaying && !emergency) return;

                slot.isPlaying = false;
                slot.playbackScheduledEvents.forEach(clearTimeout);
                slot.playbackScheduledEvents = [];
                
                const notesToStop = new Set(slot.notesCurrentlyPlaying);
                notesToStop.forEach(noteString => {
                    const noteOnEvent = slot.recordedEvents.find(ev => ev.type === 'noteon' && ev.note === noteString);
                    const paramsForStop = noteOnEvent ? noteOnEvent.synthParams : null;
                    
                    if (slot.soundUnits[noteString]) {
                        while(slot.soundUnits[noteString].length > 0) {
                           stopNote(noteString, `looper-slot-${slotId}`, paramsForStop); 
                        }
                    }
                });
                slot.notesCurrentlyPlaying.clear();
                // slot.soundUnits = {}; // Keep soundUnits if notes are just stopping with release; clear if emergency?
                                      // stopNote will handle removing its instance. If all done, it will be empty.

                if (!emergency) {
                     slot.statusText = slot.recordedEvents.length > 0 ? `Stopped (${(slot.loopDuration / 1000).toFixed(1)}s)` : "Empty";
                } else { // From Panic button
                     slot.statusText = slot.recordedEvents.length > 0 ? `Panic Stop (${(slot.loopDuration / 1000).toFixed(1)}s)`: "Panic Stop (Empty)";
                }
                updateAllLoopSlotButtons();
            }
            
            function playbackLoopSlot(slotId, loopCycleStartAudioTime) {
                const slot = loopSlotsData[slotId];
                if (!slot.isPlaying || slot.recordedEvents.length === 0 || slot.loopDuration <= 0) { // loopDuration must be > 0
                    if (slot.isPlaying) stopPlaybackForSlot(slotId);
                    return;
                }

                slot.playbackScheduledEvents = [];

                slot.recordedEvents.forEach(event => {
                    const eventTimeInLoopSec = event.time / 1000.0;
                    const scheduledAudioTime = loopCycleStartAudioTime + eventTimeInLoopSec;
                    const delayMs = Math.max(0, (scheduledAudioTime - audioContext.currentTime) * 1000);

                    let timeoutId;
                    if (event.type === 'noteon') {
                        timeoutId = setTimeout(() => {
                            if (slot.isPlaying) { 
                                playNote(event.note, event.velocity, `looper-slot-${slotId}`, true, event.synthParams);
                            }
                        }, delayMs);
                    } else if (event.type === 'noteoff') {
                        timeoutId = setTimeout(() => {
                            if (slot.isPlaying) { 
                                const noteOnEvent = slot.recordedEvents.find(ev => ev.type === 'noteon' && ev.note === event.note && ev.time < event.time); 
                                const paramsForStop = noteOnEvent ? noteOnEvent.synthParams : null;
                                stopNote(event.note, `looper-slot-${slotId}`, paramsForStop);
                            }
                        }, delayMs);
                    }
                    if (timeoutId) slot.playbackScheduledEvents.push(timeoutId);
                });

                const loopDurationSec = slot.loopDuration / 1000.0;
                const nextCycleStartAudioTime = loopCycleStartAudioTime + loopDurationSec;
                const repeatDelayMs = Math.max(0, (nextCycleStartAudioTime - audioContext.currentTime) * 1000);

                const repeatTimeoutId = setTimeout(() => {
                    if (slot.isPlaying) { 
                        playbackLoopSlot(slotId, nextCycleStartAudioTime);
                    }
                }, repeatDelayMs);
                slot.playbackScheduledEvents.push(repeatTimeoutId);
            }

            function clearSlot(slotId) {
                if (looperQuantizationTimeout) clearTimeout(looperQuantizationTimeout);
                looperQuantizationTimeout = null;

                const slot = loopSlotsData[slotId];
                if (slot.isRecording) { 
                    slot.isRecording = false; // Stop recording immediately
                }
                if (slot.isPlaying) {
                    stopPlaybackForSlot(slotId); // Stop playback
                }
                if (currentArmedSlotId === slotId) {
                    currentArmedSlotId = -1; 
                }
                slot.recordedEvents = [];
                slot.loopDuration = 0;
                slot.loopStartTime = 0;
                slot.quantizeStartTime = 0;
                slot.notesCurrentlyPlaying.clear();
                slot.soundUnits = {};
                slot.statusText = "Empty";
                updateAllLoopSlotButtons();
            }

            function updateAllLoopSlotButtons() {
                loopSlotsData.forEach((slot, i) => {
                    const armButton = document.getElementById(`loop-slot-arm-${i}`);
                    const playButton = document.getElementById(`loop-slot-play-${i}`);
                    const clearButton = document.getElementById(`loop-slot-clear-${i}`);
                    const statusDisplay = document.getElementById(`loop-slot-status-${i}`);
                    const armedLed = document.getElementById(`loop-slot-armed-led-${i}`);
                    const recordLed = document.getElementById(`loop-slot-record-led-${i}`);
                    const playLed = document.getElementById(`loop-slot-play-led-${i}`);

                    if (!armButton || !playButton || !clearButton || !statusDisplay || !armedLed || !recordLed || !playLed) return;
                    
                    statusDisplay.textContent = slot.statusText;

                    // Arm/Record/Stop Rec Button Logic
                    if (slot.isRecording) {
                        armButton.textContent = 'Stop Rec';
                        armButton.classList.add('recording');
                        armButton.classList.remove('armed');
                        armButton.disabled = false;
                    } else if (currentArmedSlotId === i) { // Armed but not recording
                        armButton.textContent = 'Record';
                        armButton.classList.add('armed');
                        armButton.classList.remove('recording');
                        armButton.disabled = slot.isPlaying; // Can't record if playing
                    } else { // Not armed, not recording
                        armButton.textContent = 'Arm';
                        armButton.classList.remove('armed', 'recording');
                        // Disable arming if another slot is currently recording
                        const anotherSlotIsRecording = loopSlotsData.some(s => s.id !== i && s.isRecording);
                        armButton.disabled = anotherSlotIsRecording || slot.isPlaying;
                    }
                    
                    armedLed.classList.toggle('active', currentArmedSlotId === i && !slot.isRecording);
                    recordLed.classList.toggle('active', slot.isRecording); 
                    playLed.classList.toggle('active', slot.isPlaying);


                    playButton.textContent = slot.isPlaying ? 'Stop' : 'Play';
                    playButton.disabled = slot.isRecording || (slot.recordedEvents.length === 0 && !slot.isPlaying);
                    playButton.classList.toggle('playing', slot.isPlaying);
                    
                    clearButton.disabled = slot.isRecording || slot.isPlaying;
                });
            }


            window.addEventListener('load', () => {
                baseOctaveSelect = document.getElementById('baseOctave'); oscSlopInput = document.getElementById('oscSlop');
                enableAdsrToggle = document.getElementById('enableAdsr'); attackInput = document.getElementById('attack'); decayInput = document.getElementById('decay'); sustainInput = document.getElementById('sustain'); releaseInput = document.getElementById('release'); adsrControls = document.getElementById('adsr-controls');
                enableFilterToggle = document.getElementById('enableFilter'); filterTypeSelect = document.getElementById('filterType'); filterCutoffInput = document.getElementById('filterCutoff'); filterResonanceInput = document.getElementById('filterResonance'); filterControlsElement = document.getElementById('filter-controls');
                masterVolumeInput = document.getElementById('masterVolume'); numOctavesSelect = document.getElementById('numOctavesSelect'); visualizerSourceSelect = document.getElementById('visualizerSourceSelect');
                keyboardContainer = document.getElementById('keyboard'); uiThemeSelect = document.getElementById('uiTheme'); uiScaleInput = document.getElementById('uiScale');
                synthesiaToggle = document.getElementById('synthesiaToggle'); synthesiaContainer = document.getElementById('synthesiaContainer'); stopAllSoundsButton = document.getElementById('stopAllSoundsButton');
                toggleLooperButton = document.getElementById('toggleLooperButton');
                
                launchpadLooperContainer = document.getElementById('launchpadLooperContainer');

                metronomeToggle = document.getElementById('metronomeToggle'); bpmDisplay = document.getElementById('bpmDisplay'); bpmIncrement = document.getElementById('bpmIncrement'); bpmDecrement = document.getElementById('bpmDecrement'); tapTempoButton = document.getElementById('tapTempoButton'); metronomeLed = document.getElementById('metronomeLed');

                // The saved theme and scale are already on the page (js/themes.js); the controls show them.
                if(uiThemeSelect)uiThemeSelect.value=window.uiThemes.theme; if(uiScaleInput)uiScaleInput.value=window.uiThemes.scale; resizeCanvas();
                const sE=localStorage.getItem('synthesiaEnabled')!=='false'; if(synthesiaToggle){synthesiaToggle.checked=sE; if(synthesiaContainer)synthesiaContainer.classList.toggle('active',sE);}

                initAudio();
                createKeyboard();
                // The piano roll's lanes follow the keys when the keyboard's widget is resized or moved.
                new ResizeObserver(() => { if (synthesiaContainer.classList.contains('active')) createSynthesiaGrid(); }).observe(keyboardContainer);
                setupKeyboardEvents();
                setupControlEvents(); // This now includes looper toggle listener
                
                initializeLoopSlots(); 

                metronomeToggle.addEventListener('change', toggleMetronome); bpmIncrement.addEventListener('click', () => adjustBPM(1)); bpmDecrement.addEventListener('click', () => adjustBPM(-1)); tapTempoButton.addEventListener('click', handleTapTempo);
                updateBPMDisplay();

                window.addEventListener('resize',resizeCanvas);
                if(audioContext && audioContext.state === 'suspended') { const rA=()=>{if(audioContext&&audioContext.state==='suspended'){audioContext.resume().then(()=>{console.log("AudioContext resumed.");}).catch(e=>console.error("Error resuming AC:",e));}document.removeEventListener('click',rA);document.removeEventListener('keydown',rA);document.removeEventListener('touchstart',rA);};document.addEventListener('click',rA);document.addEventListener('keydown',rA);document.addEventListener('touchstart',rA);}
                if(sE && audioContext && synthesiaContainer && synthesiaContainer.classList.contains('active')) createSynthesiaGrid();
            });

window.synth = {
 get context() { return audioContext; },
 get fx() { return { input: fxInput, output: fxOutput }; },
 get voices() { return voiceBus; },
 get instrumentInput() { return masterGain; },
 ensureAudio: () => { if (!audioContext) initAudio(); return audioContext; },
 get tempo() { return currentBPM; },
 set tempo(value) { currentBPM = Math.max(30, Math.min(300, value)); updateBPMDisplay(); if (metronomeIntervalId) startMetronome(); }, // a clicking metronome keeps up
 get metronome() { return metronomeEnabled && !!metronomeIntervalId; },
 perfTimeOf: t => perfTimeOf(t),
 noteOn: note => playNote(note, 0.65, 'sequencer', true),
 noteOff: note => stopNote(note, 'emergency'),
 click: () => { if (metronomeEnabled) metronomeTick(); },
 suspendClick: () => stopMetronome(),
 resumeClick: () => { if (metronomeEnabled) startMetronome(); },
 get output() { return masterLimiter; },
 panic: () => emergencyStopAllSounds(),
 params: () => getCurrentSynthParams(),
 loops: () => loopSlotsData.map(s => ({ events: s.recordedEvents, duration: s.loopDuration, busy: s.isRecording || s.isPlaying })),
 setLoop: (id, events, duration) => {
  const slot = loopSlotsData[id];
  if (slot.isRecording) slot.isRecording = false;
  if (slot.isPlaying) stopPlaybackForSlot(id);
  Object.assign(slot, { recordedEvents: events, loopDuration: duration, quantizeStartTime: 0, soundUnits: {}, statusText: `Imported (${(duration / 1000).toFixed(1)}s)` });
  slot.notesCurrentlyPlaying.clear();
  updateAllLoopSlotButtons();
 },
 // Starts a loop slot immediately, skipping beat quantization, so a bounce begins on its first frame.
 playLoop: id => { if (!audioContext) initAudio(); const slot = loopSlotsData[id]; if (slot.isPlaying || !slot.recordedEvents.length || slot.loopDuration <= 0) return false; const q = slot.quantizeStartTime; slot.quantizeStartTime = 0; startPlaybackForSlot(id); slot.quantizeStartTime = q; return true; },
 stopLoop: id => stopPlaybackForSlot(id)
};

# Changelog

## 1.3.1

- **Effects opens the selected part**: select a part in Arrange, tap *Effects*, and that part's chain is shown (switching track if needed). Opening effects from a specific place, such as the Master strip in the Mixer, still goes there.
- **Floating zoom pill**: Fit, zoom out and zoom in moved out of the toolbar into a pill that floats over the bottom-right of the timeline, so the toolbar has room for editing tools. Hold a zoom button to keep zooming.
- **Effect colours**: every effect has its own colour (Reverb indigo, Delay blue, Lo-Fi yellow, EQ green, Compressor orange, Filter teal, Distortion rose, Chorus pink), used on its card, icon, power button, Mixer chip and curve lane. Shades are tuned per theme to meet WCAG AA contrast.
- **Export help**: a **?** next to *WAV bit depth* and *Sample rate* opens a short explanation of what each option does to quality and size, with a live estimate of the export's file size.
- Mixer: the FX list keeps a fixed height so faders line up; extra effects show as "+N more". On landscape phones the strip no longer cuts off the level readout and output button.
- Keyboard: Enter and Space on a focused button press that button instead of triggering play/stop.

## 1.3.0

- **New look**: one palette for every section, taken from the logo: orange accent, neutral greys and near-black or white. Track colours stay multi-coloured for identification. Red, yellow and green are used only for alerts and status (mute, delete, errors, saving, meters).
- **Dark and light themes**: *Project → Settings → Appearance* (System, Light, Dark). "System" follows the phone, including on Android, where the status and navigation bars change with the theme. Both themes meet WCAG 2.2 AA contrast (checked with axe-core on every section).
- **Solo removed**: to hear one track, mute the others. The three-dot track menu takes its place in the track header (and in the Mixer). Sessions that had solo switched on play every track.
- **Sheets** slide up from the bottom of the screen and can be closed by dragging the holding bar down (or with a quick flick).
- **Smoother navigation**: a pill glides to the current section and pages slide in from the side they sit on.
- **Toolbar**: Fit, zoom out and zoom in are pinned at the right end; the clip count only shows when several clips are selected.
- Fixed: the track menu said "Effects: none" when a track's parts had effects.

## 1.2.0

- **New name and icon: SnapWav** (app ID `io.github.snapwav`). Sessions and settings from Strata move over automatically the first time SnapWav opens in the same browser.
- **Landscape layout**: tracks on the left; tools, the selected track's options as tiles (mute, solo, effects, curves, colour, height, phase, rename, duplicate, move, delete), volume and pan, transport and navigation on the right.
- **Roomier track headers**: no track name; mute, solo, curves, effects and options icons in a column on the left, as many as the track height allows.
- **Timeline in minutes and seconds** instead of bars and beats; the metronome and the tempo display are gone (a tempo remains only for *Snap → Beats*).
- **Snap modes**: *Default* (clips, markers, loop and playhead), *Beats* (1/16 to a bar) or *Off*.
- **Markers**: unnamed; the *Marker* button lights up as *Remove marker* when the playhead is within 100 ms of one.
- **Add track** offers *Import new track*, *Add from media* and *Add empty track*. Creating buses was removed; buses in older or imported projects still work.
- **Effects**: reset button next to every slider, a curve for each effect's intensity instead of every setting, and named effect-chain presets that can be applied to other parts and tracks.
- **Zoom**: the zoom buttons come first in the toolbar; press and hold to keep zooming.
- **Project page** shows how much storage the open session uses (measured when it is opened).
- Fixed: adjusting an effect slider scrolled the Effects page back to the top.
- Fixed: reverb and delay tails kept ringing after pausing.
- Fixed: on some browsers, closing one sheet and opening another quickly could make the Back button leave the app.

## 1.1.0

- **Android app** (`io.github.snapwav`): offline WebView app with Share/Open with SnapWav, system Save picker for exports, Back-button support, keep-screen-on during playback and haptics.
- **Effects per part**: splitting a track gives each part its own effect chain; *Apply to all parts* copies an effect across the track and can keep copies in sync. Older projects are converted automatically.
- **Curve lanes**: draw curves for track volume/pan and, inside each part, part volume, part pan and any effect parameter. Dashed default line with magnetic snapping, value bubble while dragging, taller selected track.
- **MP3 export** (128–320 kbps) for the mix and for stems.
- Fonts are bundled, so the app looks the same offline.
- Fixed: after undo/redo, playback could play clips that had been deleted or moved.
- Fixed: Lo-Fi hiss and crackle, and a Fuzz DC offset, were audible where there was no audio; silent regions now export as true silence.

## 1.0.0

- First release: arrange, mixer, eight effects with presets, media pool, sessions with undo/redo and autosave, WAV and stem export, session archives, DAWproject import/export, installable web app.

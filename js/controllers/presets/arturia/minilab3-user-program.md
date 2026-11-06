# A MiniLab 3 User program for this app

MIDI Control Center (MCC) writes its own files for MiniLab 3 programs, and that
format isn't documented, so this is a recipe rather than a file: five settings,
made once in MCC, give a User program the app reads as **User, relative
encoders (recommended)** in the Controllers widget.

Why: in the Arturia and DAW programs the eight encoders send absolute values
(0 to 127), so a knob must reach a parameter's value before it moves it
(pick-up). Set to Relative 1, an encoder sends only which way and how far it
turned, and moves the parameter smoothly from wherever it is. Relative encoders
need firmware 1.1 or later (Arturia's firmware page; Sound On Sound's report of
1.1), and Arturia's QA on the forum confirms Relative 1 is binary offset
(64 is no move), which is what the preset reads.

1. Update the MiniLab 3 to firmware 1.1 or later (MCC offers the update).
2. In MCC, pick a User program and keep the factory CCs: encoders 74, 71, 76,
   77, 93, 18, 19, 16; faders 82, 83, 85, 17; main encoder 114 (Shift 112),
   click 115 (Shift 113); Shift 9; pads bank A notes 36-43 and bank B 44-51 on
   channel 10; Shift + pads 4-8 CC 105-109. (These are Arturia's own defaults
   for User programs, in its MIDI implementation chart.)
3. Set each of the eight encoders' mode to **Relative 1**.
4. Leave the faders absolute (they have a position).
5. Send the program to the controller, and pick it with Shift + Pad 3.

In the app, open Controllers and set Program to **User, relative encoders
(recommended)**. The controller doesn't say which User program it is in, so the
app can't tell this one from a factory User program by itself; the choice is
kept for the device. If you changed anything else, use MIDI learn.

Not verified on hardware yet: the messages are from Arturia's documents (see
minilab3.json's sources).

# Sidebar layout tabs
Objective: Port sidebar-fresh tabs to this worktree, with customization under Layout.
Branch: feat/sidebar-layout-tabs | Delivery: single-pr; forecast ~950 changed lines | Runner: project test suite

## Specs
- S1: «es sidebar Fresh, vas a ese WorkTree y chusmías todo lo que se hizo, eh que es agregar tab, que las vamos están agregadas a partir de customize section, pero ahora lo que vamos a hacer en este en esta WorkTree es lo mismo, pero lo vamos a agregar a partir de layout en vez de section.»
- S2: «si es eso exactamente, comenza por eso» — acceptance refers to the preceding proposal: port existing sidebar-fresh functionality, put Tabs and Configure tabs under Customize → Layout, preserve Task summary and global preference, adapt tests.
- S3: «tabs va abajo de todas, no en ese lugar. otra cosa cuando entramos a la configuracion la idea es q tenga los ocntroles on / off con el circulito rosa cuando esta en on despliega las opciones a tildar, en en git por ejemplo podria ser git y diff»
- S4: «claro diff se va a gregar luego , debajo de git»
- S5: «el on despliega las opciones q se pueden tener en esa tab. y se le hace check a la q queremos ver. siempre q haya mas de una, si una tab solo tiene una y se la habilita se ve por defecto la q esta»
- S6: «en ese caso se ve main por defecto sin la tab arriba, asi tal cual aparece actualmente»
- S7: «vamos a tomar el [Image#2] y le ponemos la misma funcionalidad de [Image#3] apretamos TODOS por ejemplo, y se despliega o se compacta. ese mismo efecto deberiamos tenerlo en git , y luego en diff cuando lo implementemos»
- S8: «podriamos agregar lo de diff. asi l vamos implementando. eso iria debajo de git, y tenndria q ponerse debajo, cada uno ocupa la mitad de la sidebar, se usa la misma estructura, revisa q esta en un worktree anterior, nose si en el anteriror estuvo, o uno mas viejo q quedo por ahi»
- S9: «vamos a meterle colorcitos carpetita de un color, archivo q se vea de otro, asi extensions/gentle-shell.ts a esto me refiero. luego [diff] de otro color  sobre el borde derecho. y podemos mostrar el numero de  lineas en color rojos y verdes, dependiendo las q se eliminaron o agregaron si son archivos modificado q los podemo sponer antes del diff         +67 -34 [diff] algo asi»
- S10: «+67  -34  [diff] no tamto especio entre ellos, porq no tenemos mucho espacio, el minimo e indispensable»
- S11: «bien, si implementemoslo, con mucho cuidado» — «Si estás en un worktree: ofrecer MAIN / WORKTREE. Cada opción muestra únicamente el historial y los cambios de esa raíz»; «Si estás en el checkout principal: mostrar solo MAIN»; «Cero consultas Git por frame y ninguna consulta nueva de la vista mientras GIT esté oculta».
- S12: «me equivoque, la idea es que se vea entero»; «si, me parece bien» — accepted automatic soft wrap of diff preview with visual-row scrolling and cached wrapping.

## Tasks
- T1 [S1,S2] Port sidebar-fresh navigation, configuration, Git destination, tests and docs; place controls under Layout. Route: inline, dependent behavior; status: in_progress; commit: pending.
- T2 [S1,S2] Verify focused and full checks, including shared behavior differential. Route: independent verifier for shared-contract risk; status: pending; commit: pending.
- T3 [S3,S4,S5,S6] Place Tabs last and implement requested tab controls; Diff to be added later. Route: delegated (context backstop); status: pending; commit: pending.
- T4 [S7] Make Git history expand and collapse like existing sidebar sections. Route: delegated (context backstop); status: done; commit: 85c4c0426.
- T5 [S3,S5,S7,S8,S9,S10] Add Diff below Git, diagnose failure and polish compact colored file rows. Route: delegated bounded continuation; status: blocked awaiting explicit continuation; commit: pending.
- T6 [S11] Add primary/current worktree selector and selected-root lifecycle with bounded work. Route: delegated (context backstop); status: blocked pending failing root-switch test; commit: pending.
- T7 [S12] Soft-wrap diff preview lines with bounded cached rendering. Route: delegated (context backstop); status: in_progress; commit: pending.

## Log
- L1: «Bien, quiero que vayas al WorkTree a modo de exploración, es sidebar Fresh, vas a ese WorkTree y chusmías todo lo que se hizo, eh que es agregar tab, que las vamos están agregadas a partir de customize section, pero ahora lo que vamos a hacer en este en esta WorkTree es lo mismo, pero lo vamos a agregar a partir de layout en vez de section. ¿Sí? Así que revisá y decime más o menos que tenés que antes de empezar a implementar algo, eh decime lo que viste. no hagas nada sino informame»
- L2: «si es eso exactamente, comenza por eso»
- L3: Reference branch feat/sidebar-fresh has two commits and ~951 changed lines versus the common base, including existing ODD notes. Port must preserve current Layout Task summary and existing behavior; do not copy prior tracking files.
- L4: «tabs va abajo de todas, no en ese lugar. otra cosa cuando entramos a la configuracion la idea es q tenga los ocntroles on / off con el circulito rosa cuando esta en on despliega las opciones a tildar, en en git por ejemplo podria ser git y diff»
- L5: «claro diff se va a gregar luego , debajo de git»
- L6: «el on despliega las opciones q se pueden tener en esa tab. y se le hace check a la q queremos ver. siempre q haya mas de una, si una tab solo tiene una y se la habilita se ve por defecto la q esta»
- L7: «en ese caso se ve main por defecto sin la tab arriba, asi tal cual aparece actualmente»
- L8: «todavia no vamos a preparar nada»
- L9: «si, porq podemos hacer un pr mas grande, no tiene q ser de 400 lineas, me dijo alan, tengo en ese sebntodo el permiso mas amplio, y poder entregar una feature mas completa»
- L10: «vamos a tomar el [Image#2] y le ponemos la misma funcionalidad de [Image#3] apretamos TODOS por ejemplo, y se despliega o se compacta. ese mismo efecto deberiamos tenerlo en git , y luego en diff cuando lo implementemos»
- L11: S7 focused 372 passed, full suite 8916 passed, 84 skipped; typecheck and runtime module checks passed. Independent isolated verification passed folding and existing MAIN differential; three metadata-dependent tests fail in scratch as on baseline.
- L12: «bien, hasta ahora va quedando bien, podemos hacer un commit, para q ya tengamos esto resguardado, y seguir, de paso dame el resumen de lo q me esta llevando cada cosa»
- L13: Commit 85c4c0426 captures implementation, tests, and docs; latest full suite 8917 passed and 84 skipped. User visually confirmed Git card scroll. Performance benchmark remains blocked by missing audited Pi 1.2.0 host; no PR or push.
- L14: «creo q estamos bien, en lineas, podriamos agregar lo de diff. asi l vamos implementando. eso iria debajo de git, y tenndria q ponerse debajo, cada uno ocupa la mitad de la sidebar, se usa la misma estructura, revisa q esta en un worktree anterior, nose si en el anteriror estuvo, o uno mas viejo q quedo por ahi»
- L15: «si, eso mismo»
- L16: Earlier working-tree listing and selected-file diff are in .worktrees/cinlo-cute; use as reference without changing it. MAIN/WORKTREE root switching is not requested.
- L17: T5 partial. Interaction test `Git and Diff share the viewport` failed twice: expected added file and counts, got `No changes.` Fixture versus product cause not established. Typecheck passed. Height, independent scrolling, folding, options, status accuracy, overlay, hidden work, docs and full verification remain incomplete. Worker-local correction limit reached.
- L18: «vamos a meterle colorcitos carpetita de un color, archivo q se vea de otro, asi extensions/gentle-shell.ts a esto me refiero. luego [diff] de otro color  sobre el borde derecho. y podemos mostrar el numero de  lineas en color rojos y verdes, dependiendo las q se eliminaron o agregaron si son archivos modificado q los podemo sponer antes del diff         +67 -34 [diff] algo asi»
- L19: «+67  -34  [diff] no tamto especio entre ellos, porq no tenemos mucho espacio, el minimo e indispensable»
- L20: «si, revisa a ver q es lo q esta pasando» — accepted bounded continuation previously proposed: diagnose failing test and apply style, at most two corrections per failing check.
- L21: Fixture synchronization caused initial empty Diff; after awaiting agent_end, real status/count bug fixed and compact colored rows added. Focused 481 passed; types passed. Geometry, narrow widths, click targets, toggles, overlay lifecycle, hidden work, docs and differential unverified.
- L22: «estas usando colores de los theme?? q no sean harcodeos. si hacelo. lo probe y todo funciono bien, por si te sirve» — user confirms visual functional test and authorizes bounded continuation.
- L23: Bounded continuation fixed card spacing and duplicate overlay openings, updated docs; focused 481 passed and typecheck passed. Colors use theme roles. Full equal-height geometry, narrow click boundaries, checkbox toggles, inactive work, overlay session lifecycle and differential remain unverified.
- L24: «si, hacelo de neuvo, a la visual quedo todo bien [Image#8]» — user authorizes bounded continuation and confirms appearance.
- L25: Bounded continuation added tests for checkbox persistence, approximate midpoint across surfaces/styles and overlay shutdown widget updates. Focused 481 passed; types passed. Exact geometry, narrow clicks, hidden work, overlay disposal races and baseline differential remain unverified; continuation partial.
- L26: «bien, si implementemoslo, con mucho cuidado» — selector MAIN/WORKTREE, with bounded rendering and selected-root work.
- L27: T6 worker made no changes: selected-root Diff overlay currently uses session-wide tracker and poller, so correct root isolation depends on T5 overlay lifecycle. T5 prior correction cycle exhausted. Typecheck passed; selector tests not run.
- L28: «si, retomalo»; «ok» — authorized bounded prerequisite and lifecycle continuation.
- L29: Root-local overlay isolation and delayed shutdown test initially passed; overlap test exposed tracker initialization race. Last focused run still fails `closed session cannot start a refresh`, observing /repo:diff and /repo:status after shutdown; origin unknown. Typecheck passed; baseline differential, ordinary close and session replacement unverified. Correction limit reached; no selector implementation.
- L30: User confirmed selector visually works; automated MAIN root-switch test remains failing.
- L31: «vamos a ver como arreglamos el tema del codigo, para que no se vea cortado»; «me equivoque, la idea es que se vea entero»; «si, me parece bien» — approves proposed automatic soft wrap.

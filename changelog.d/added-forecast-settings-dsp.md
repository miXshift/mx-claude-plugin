- **A forecast can now count DSP spend.** `mixshift forecast settings set --scope <scope_id>
  --include-dsp on` switches an account's DSP spend into the spend its computed forecast stands
  on; the answer then reads `spend_basis: ads_plus_dsp` and names the months whose DSP spend
  joined the fit. `mixshift forecast settings show` reads the settings back, and
  `--missing-ad-spend-as-zero on|off` sets whether a month with sales and no ad rows trains as
  zero spend. The Forecast Max skill asks once about DSP, the way it asks about the budget,
  when the warehouse holds DSP months for the account. Needs MixShift's forecasting service
  with correction-aware readiness (a backfilled month now counts toward the forecast floor).

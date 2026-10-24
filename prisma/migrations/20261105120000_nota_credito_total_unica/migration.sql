-- UNA nota de crédito TOTAL (motivos 01, 02, 06) viva por comprobante.
-- «Viva» = no rechazada: una nota rechazada por el proveedor ya gastó su correlativo pero no anuló nada,
-- así que no impide emitir otra. Prisma no expresa índices parciales: va a mano (como el de una venta, un comprobante).
-- Expand puro (solo añade un índice): no necesita down.sql.
CREATE UNIQUE INDEX "tax_documents_una_nota_credito_total"
  ON "tax_documents"("tenantId", "relatedDocumentId")
  WHERE "documentType" = 'NOTA_CREDITO'
    AND "reasonCode" IN ('01', '02', '06')
    AND "status" <> 'RECHAZADO';

const express = require('express');
const axios = require('axios');
require('dotenv').config();
const cors = require('cors');
const requestIp = require('request-ip');

const app = express();
app.use(requestIp.mw());
app.use(express.json());
app.use(cors({
  origin: '*',
}));

function getAuthHeader() {
  return `Basic ${process.env.BYNET_BASIC_AUTH}`;
}

const sendToUtmify = async (payload) => {
  try {
    const response = await axios.post('https://api.utmify.com.br/api-credentials/orders', payload, {
      headers: {
        'x-api-token': process.env.UTMIFY_API_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    console.log('Venda enviada com sucesso para a Utmify:', response.data);
  } catch (error) {
    console.error('Erro ao enviar venda para a Utmify:', error.response?.data || error.message);
  }
};

const utmStore = {};

app.post('/gerar-pix', async (req, res) => {
  const {
    amount,
    customer,
    items,
    pixExpiresInDays,
    postbackUrl,
    metadata,
    utm_source,
    utm_campaign,
    utm_medium,
    utm_content,
  } = req.body;

  if (!amount || !customer || !items || !pixExpiresInDays) {
    return res.status(400).json({
      error: 'Os campos amount, customer, items e pixExpiresInDays são obrigatórios.',
    });
  }

  try {
    const clientIp = req.clientIp || '0.0.0.0';

    const pixResponse = await axios.post(
      'https://api.bynetglobal.com.br/v1/transactions',
      {
        amount,
        paymentMethod: 'pix',
        customer,
        items,
        pix: {
          expiresInDays: pixExpiresInDays,
        },
        postbackUrl,
        metadata,
      },
      {
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    const pixData = pixResponse.data;

    utmStore[pixData.id] = {
      utm_source,
      utm_campaign,
      utm_medium,
      utm_content,
    };

    const utmifyPayload = {
      orderId: pixData.id,
      platform: 'GlobalPay',
      paymentMethod: 'pix',
      status: 'waiting_payment',
      createdAt: new Date(pixData.createdAt).toISOString().replace('T', ' ').slice(0, 19),
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone || null,
        document: customer.document.number,
        country: customer.country || 'BR',
        ip: clientIp,
      },
      products: items.map((item) => ({
        id: item.id || Math.random().toString(36).substring(7),
        name: item.title,
        planId: null,
        planName: null,
        quantity: item.quantity,
        priceInCents: item.unitPrice,
      })),
      trackingParameters: {
        src: null,
        sck: null,
        utm_source,
        utm_campaign,
        utm_medium,
        utm_content,
        utm_term: metadata?.utm_term || null,
      },
      commission: {
        totalPriceInCents: amount,
        gatewayFeeInCents: Math.round(amount * 0.03) + 100,
        userCommissionInCents: Math.round(amount * 0.97),
      },
      isTest: false,
    };

    await sendToUtmify(utmifyPayload);

    res.status(200).json({
      statusCode: 200,
      data: pixData,
    });
  } catch (error) {
    console.error('Erro ao criar transação PIX:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || 'Erro interno no servidor',
    });
  }
});

app.get('/status-pagamento/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'O ID da transação é obrigatório.' });
  }

  try {
    const response = await axios.get(
      `https://api.bynetglobal.com.br/v1/transactions/${id}`,
      {
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    const transaction = response.data;

    if (transaction.status === 'paid') {
      const customerIp = transaction.customer?.ip || '0.0.0.0';
      const utms = utmStore[id] || {};

      const utmifyPayload = {
        orderId: transaction.id,
        platform: 'GlobalPay',
        paymentMethod: 'pix',
        status: 'paid',
        createdAt: new Date(transaction.createdAt).toISOString().replace('T', ' ').slice(0, 19),
        approvedDate: new Date(transaction.paidAt).toISOString().replace('T', ' ').slice(0, 19),
        refundedAt: null,
        customer: {
          name: transaction.customer.name,
          email: transaction.customer.email,
          phone: transaction.customer.phone || null,
          document: transaction.customer.document.number,
          country: 'BR',
          ip: customerIp,
        },
        products: transaction.items.map((item) => ({
          id: item.id || Math.random().toString(36).substring(7),
          name: item.title,
          planId: null,
          planName: null,
          quantity: item.quantity,
          priceInCents: item.unitPrice,
        })),
        trackingParameters: {
          src: null,
          sck: null,
          utm_source: utms.utm_source || null,
          utm_campaign: utms.utm_campaign || null,
          utm_medium: utms.utm_medium || null,
          utm_content: utms.utm_content || null,
          utm_term: null,
        },
        commission: {
          totalPriceInCents: transaction.amount,
          gatewayFeeInCents: transaction.fee?.fixedAmount || 0,
          userCommissionInCents: transaction.amount - (transaction.fee?.fixedAmount || 0),
        },
        isTest: false,
      };

      await sendToUtmify(utmifyPayload);
    }

    res.status(200).json({
      statusCode: 200,
      data: transaction,
    });
  } catch (error) {
    console.error('Erro ao buscar status do pagamento:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || 'Erro interno no servidor',
    });
  }
});

app.post('/webhook-pagamento', async (req, res) => {
  try {
    const { id, status, paidAt } = req.body;

    // Verifica se os dados são válidos
    if (!id || !status) {
      return res.status(400).json({ error: 'Dados inválidos no webhook' });
    }

    console.log(`Recebido webhook para ID: ${id} com status: ${status}`);

    // Caso o status seja 'paid', envie para a Utmify
    if (status === 'paid') {
      const transactionResponse = await axios.get(
        `https://api.bynetglobal.com.br/v1/transactions/${id}`,
        {
          headers: {
            Authorization: getAuthHeader(),
            'Content-Type': 'application/json',
          },
        }
      );

      const transaction = transactionResponse.data;

      const customerIp = transaction.customer?.ip || '0.0.0.0';
      const utms = utmStore[id] || {};

      const utmifyPayload = {
        orderId: transaction.id,
        platform: 'GlobalPay',
        paymentMethod: 'pix',
        status: 'paid',
        createdAt: new Date(transaction.createdAt).toISOString().replace('T', ' ').slice(0, 19),
        approvedDate: new Date(transaction.paidAt || paidAt).toISOString().replace('T', ' ').slice(0, 19),
        refundedAt: null,
        customer: {
          name: transaction.customer.name,
          email: transaction.customer.email,
          phone: transaction.customer.phone || null,
          document: transaction.customer.document.number,
          country: 'BR',
          ip: customerIp,
        },
        products: transaction.items.map((item) => ({
          id: item.id || Math.random().toString(36).substring(7),
          name: item.title,
          planId: null,
          planName: null,
          quantity: item.quantity,
          priceInCents: item.unitPrice,
        })),
        trackingParameters: {
          src: null,
          sck: null,
          utm_source: utms.utm_source || null,
          utm_campaign: utms.utm_campaign || null,
          utm_medium: utms.utm_medium || null,
          utm_content: utms.utm_content || null,
          utm_term: null,
        },
        commission: {
          totalPriceInCents: transaction.amount,
          gatewayFeeInCents: transaction.fee?.fixedAmount || 0,
          userCommissionInCents: transaction.amount - (transaction.fee?.fixedAmount || 0),
        },
        isTest: false,
      };

      await sendToUtmify(utmifyPayload);
      console.log('Venda enviada com sucesso para a Utmify via webhook');
    }

    res.status(200).json({ message: 'Webhook recebido com sucesso' });
  } catch (error) {
    console.error('Erro ao processar webhook:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro interno ao processar webhook' });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

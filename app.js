const pixForm = document.getElementById('pixForm');
const qrCodeDiv = document.getElementById('qrCode');
const statusDiv = document.getElementById('status');
const generatePixButton = document.getElementById('generatePix');

let transactionId = null;
let pollingInterval = null;

pixForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  generatePixButton.disabled = true;
  statusDiv.textContent = 'Gerando QR Code PIX...';

  const formData = new FormData(pixForm);
  const rawCpf = formData.get('cpf');
  const cleanCpf = rawCpf.replace(/\D/g, '');

  const payload = {
    amount: parseInt(formData.get('amount'), 10),
    customer: {
      name: formData.get('name'),
      email: formData.get('email'),
      document: {
        number: cleanCpf,
        type: 'cpf',
      },
    },
    items: [
      {
        title: formData.get('title'),
        unitPrice: parseInt(formData.get('amount'), 10),
        quantity: parseInt(formData.get('quantity'), 10),
        tangible: false,
      },
    ],
    pixExpiresInDays: 2,
    postbackUrl: 'https://sua-api.com/webhooks/bynet',
  };

  try {
    const response = await fetch('http://192.168.0.110:3000/gerar-pix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error('Erro na API');

    const data = await response.json();
    transactionId = data.data.id;

    console.log('Payload da Resposta:', data);

    if (data.data.pix && data.data.pix.qrcode) {
      qrCodeDiv.innerHTML = `
        <p>QR Code:</p>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
          data.data.pix.qrcode
        )}" alt="QR Code PIX" />
      `;
    } else {
      qrCodeDiv.innerHTML = '<p>QR Code não disponível.</p>';
    }

    statusDiv.textContent = 'Aguardando pagamento...';
    startPolling();
  } catch (error) {
    console.error('Erro ao gerar PIX:', error);
    statusDiv.textContent = 'Erro ao gerar QR Code. Tente novamente.';
    generatePixButton.disabled = false;
  }
});

async function checkPaymentStatus() {
  if (!transactionId) return;

  try {
    const response = await fetch(`http://192.168.0.110:3000/status-pagamento/${transactionId}`);
    if (!response.ok) throw new Error('Erro ao consultar status');

    const data = await response.json();

    if (data.data.status === 'paid') {
      clearInterval(pollingInterval);
      statusDiv.textContent = 'Pagamento confirmado!';
      generatePixButton.disabled = false;
    } else {
      statusDiv.textContent = `Status: ${data.data.status}`;
    }
  } catch (error) {
    console.error('Erro ao verificar status:', error);
    statusDiv.textContent = 'Erro ao verificar status.';
  }
}

function startPolling() {
  pollingInterval = setInterval(checkPaymentStatus, 5000); 
}
